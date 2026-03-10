import { ImapFlow } from "imapflow";
import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import type { Logger } from "pino";
import type { EmailForwardFilter } from "@cos-tool-bot/shared";
import { buildEmailCard } from "./email-parsers.js";
import type { LarkWebhookClient } from "./lark-webhook-client.js";

export interface ImapEmailMonitorConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  pollIntervalSec: number;
  filters: EmailForwardFilter[];
  disabledEventTypes?: string[];
}

const MAX_BATCH_SIZE = 50;
const MAX_FAIL_RETRIES = 5;
const MAX_FAILED_UIDS = 5000;

export class ImapEmailMonitor {
  private client: ImapFlow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processing = false;
  private initialized = false; // true after first snapshot of existing UIDs
  private failedUids = new Map<number, number>(); // uid -> retry count
  private sentUids = new Set<number>(); // UIDs already forwarded to Lark

  constructor(
    private config: ImapEmailMonitorConfig,
    private larkClient: LarkWebhookClient,
    private logger: Logger,
    private mentionMap?: Record<string, string>,
  ) {}

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.auth,
      logger: false,
    });
  }

  private async closeClient(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // ignore
    }
    this.client = null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.client = this.createClient();

    try {
      await this.client.connect();
      this.logger.info("IMAP connected");
    } catch (err) {
      this.logger.error(err, "IMAP connection failed, falling back to polling");
      this.client = null;
    }

    // Try IDLE mode first
    if (this.client) {
      try {
        await this.startIdle();
        return;
      } catch {
        this.logger.info("IMAP IDLE not supported, falling back to polling");
      }
    }

    // Fallback: polling
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.closeClient();
    this.failedUids.clear();
    this.sentUids.clear();
    this.initialized = false;
    this.logger.info("IMAP monitor stopped");
  }

  private async startIdle(): Promise<void> {
    if (!this.client) return;

    const lock = await this.client.getMailboxLock("INBOX");
    try {
      // Process existing unseen first
      await this.processUnseen();
    } finally {
      lock.release();
    }

    const onExists = () => {
      this.processNewMessages().catch((err) => {
        this.logger.error(err, "Error processing new IMAP messages");
      });
    };
    this.client.on("exists", onExists);

    // Keep IDLE alive
    this.client.idle().catch((err) => {
      if (this.running) {
        this.logger.error(err, "IMAP IDLE failed, switching to polling");
        this.client?.removeListener("exists", onExists);
        this.startPolling();
      }
    });
  }

  private startPolling(): void {
    const intervalMs = (this.config.pollIntervalSec || 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.processNewMessages().catch((err) => {
        this.logger.error(err, "Error during IMAP poll");
      });
    }, intervalMs);
    // Run immediately
    this.processNewMessages().catch((err) => {
      this.logger.error(err, "Error during initial IMAP poll");
    });
  }

  private async processNewMessages(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.processNewMessagesInner();
    } finally {
      this.processing = false;
    }
  }

  private async processNewMessagesInner(): Promise<void> {
    if (!this.running) return;

    // Reconnect if needed
    if (!this.client) {
      try {
        this.client = this.createClient();
        await this.client.connect();
      } catch (err) {
        this.logger.error(err, "IMAP reconnection failed");
        this.client = null;
        return;
      }
    }

    let lock;
    try {
      lock = await this.client.getMailboxLock("INBOX");
    } catch (err) {
      // Stale client — close and retry next cycle
      this.logger.error(err, "IMAP mailbox lock failed, closing stale connection");
      await this.closeClient();
      return;
    }
    try {
      await this.processUnseen();
    } finally {
      lock.release();
    }
  }

  private async snapshotExistingUids(): Promise<void> {
    if (!this.client || this.initialized) return;
    this.initialized = true;

    let count = 0;
    for await (const msg of this.client.fetch({ seen: false }, { uid: true })) {
      if (msg.uid) this.sentUids.add(msg.uid);
      if (++count > MAX_FAILED_UIDS) break;
    }
    if (count > 0) {
      this.logger.info({ count }, "Skipped existing unseen emails on first connect");
    }
  }

  private async processUnseen(): Promise<void> {
    if (!this.client) return;

    // On first run, snapshot existing UIDs so we only forward new emails
    if (!this.initialized) {
      await this.snapshotExistingUids();
      return;
    }

    // Prune failedUids: remove exhausted entries, or clear all if over absolute cap
    if (this.failedUids.size > MAX_FAILED_UIDS) {
      this.failedUids.clear();
    } else if (this.failedUids.size > 1000) {
      for (const [uid, count] of this.failedUids) {
        if (count >= MAX_FAIL_RETRIES) this.failedUids.delete(uid);
      }
    }
    // Cap sentUids to avoid unbounded growth
    if (this.sentUids.size > MAX_FAILED_UIDS) {
      this.sentUids.clear();
    }

    let visited = 0;
    for await (const msg of this.client.fetch({ seen: false }, { source: true, envelope: true })) {
      if (++visited > MAX_BATCH_SIZE) break;
      try {
        if (!msg.source) continue;

        // Skip already-sent or exhausted UIDs
        if (msg.uid && this.sentUids.has(msg.uid)) continue;
        if (msg.uid && (this.failedUids.get(msg.uid) ?? 0) >= MAX_FAIL_RETRIES) continue;

        const parsed: ParsedMail = await simpleParser(msg.source);
        const from = parsed.from?.text ?? "";
        const subject = parsed.subject ?? "";
        const textBody = parsed.text ?? "";
        const htmlBody = (typeof parsed.html === "string" ? parsed.html : "") ?? "";

        // Apply filters
        if (!this.matchesFilters(from, subject)) continue;

        // Extract GitHub usernames from To/Cc (e.g. "user@users.noreply.github.com")
        const recipientUsers = extractGitHubRecipients(parsed);

        // Parse once: get both event type and card
        const { eventType, card } = buildEmailCard(
          from,
          subject,
          textBody,
          htmlBody,
          this.mentionMap,
          recipientUsers,
        );

        // Event type filtering
        if (this.config.disabledEventTypes?.length) {
          if (this.config.disabledEventTypes.includes(eventType)) {
            this.logger.debug({ from, subject, eventType }, "Skipping disabled event type");
            if (msg.uid) this.sentUids.add(msg.uid);
            continue;
          }
        }

        const result = await this.larkClient.sendCard(card);
        if (!result.ok) {
          this.logger.warn({ error: result.error }, "Failed to send email card to Lark");
          if (msg.uid) this.failedUids.set(msg.uid, (this.failedUids.get(msg.uid) ?? 0) + 1);
          continue;
        }

        // Track as sent immediately to prevent duplicates
        if (msg.uid) this.sentUids.add(msg.uid);

        // Mark as seen — isolated try/catch so failure doesn't cause re-send
        if (msg.uid) {
          try {
            await this.client!.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
          } catch (flagErr) {
            this.logger.warn({ uid: msg.uid, err: flagErr }, "Failed to mark email as seen");
          }
          this.failedUids.delete(msg.uid);
        }
        this.logger.info({ from, subject }, "Email forwarded to Lark");
      } catch (err) {
        this.logger.error(err, "Error processing email message");
      }
    }
  }

  private matchesFilters(from: string, subject: string): boolean {
    if (this.config.filters.length === 0) return true;

    return this.config.filters.some((filter) => {
      if (filter.senderPattern) {
        if (!from.toLowerCase().includes(filter.senderPattern.toLowerCase())) return false;
      }
      if (filter.subjectPattern) {
        if (!subject.toLowerCase().includes(filter.subjectPattern.toLowerCase())) return false;
      }
      return true;
    });
  }
}

const GITHUB_NOREPLY_RE = /^(?:\d+\+)?([a-zA-Z0-9_-]+)@users\.noreply\.github\.com$/;

function extractGitHubRecipients(parsed: ParsedMail): string[] {
  const users = new Set<string>();
  const addrs = [
    ...(parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : []),
    ...(parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : []),
  ];
  for (const group of addrs) {
    if (group.value) {
      for (const addr of group.value) {
        const match = addr.address && GITHUB_NOREPLY_RE.exec(addr.address);
        if (match) users.add(match[1]!);
      }
    }
  }
  return [...users];
}
