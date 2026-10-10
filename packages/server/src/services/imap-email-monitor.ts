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

const MAX_FAIL_RETRIES = 5;
const MAX_FAILED_UIDS = 5000;
const SENT_UIDS_KEEP = 3000;

export class ImapEmailMonitor {
  private client: ImapFlow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private existsHandler: (() => void) | null = null;
  private running = false;
  private processing: object | null = null;
  private generation = 0;
  private pendingMessages = false;
  private initialized = false; // true after first snapshot of existing UIDs
  private initialUidMax = 0;
  private uidValidity: bigint | null = null;
  private failedUids = new Map<number, number>(); // uid -> retry count
  private sentUids = new Set<number>(); // UIDs already forwarded to Lark

  constructor(
    private config: ImapEmailMonitorConfig,
    private larkClient: LarkWebhookClient,
    private logger: Logger,
    private mentionMap?: Record<string, string>,
  ) {}

  private createClient(generation: number): ImapFlow {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.auth,
      logger: false,
      connectionTimeout: 30_000,
      // Auto-restart IDLE every 25min to prevent silent server disconnect (~29min timeout)
      maxIdleTime: 25 * 60 * 1000,
    });
    client.on("error", (error) => {
      if (!this.isCurrent(client, generation)) return;
      this.logger.error(error, "IMAP connection error, switching to polling");
      this.disconnect(client, generation);
    });
    client.on("close", () => this.disconnect(client, generation));
    return client;
  }

  private isCurrent(client: ImapFlow, generation: number, uidValidity?: bigint): boolean {
    return (
      this.running &&
      this.generation === generation &&
      this.client === client &&
      (uidValidity === undefined ||
        (!!client.mailbox && client.mailbox.uidValidity === uidValidity))
    );
  }

  private disconnect(client: ImapFlow, generation: number): void {
    if (!this.isCurrent(client, generation)) return;
    this.removeExistsHandler();
    this.client = null;
    client.close();
    this.startPolling();
  }

  private removeExistsHandler(): void {
    if (this.existsHandler) {
      this.client?.removeListener("exists", this.existsHandler);
      this.existsHandler = null;
    }
  }

  private async closeClient(client = this.client): Promise<void> {
    if (!client) return;
    if (this.client === client) {
      this.removeExistsHandler();
      this.client = null;
    }
    try {
      await client.logout();
    } catch {
      // A disconnected server cannot acknowledge LOGOUT.
    } finally {
      client.close();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const processing = {};
    this.processing = processing;
    const client = this.createClient(generation);
    this.client = client;
    let idleStarted = false;
    try {
      try {
        await client.connect();
      } catch (err) {
        if (this.isCurrent(client, generation)) {
          this.logger.error(err, "IMAP connection failed, falling back to polling");
          this.disconnect(client, generation);
        }
        return;
      }
      if (!this.isCurrent(client, generation)) return;
      this.logger.info("IMAP connected");
      try {
        await this.startIdle(client, generation);
        idleStarted = this.isCurrent(client, generation);
      } catch (err) {
        if (this.isCurrent(client, generation)) {
          this.removeExistsHandler();
          this.logger.info({ err }, "IMAP IDLE unavailable, falling back to polling");
        }
      }
    } finally {
      if (this.processing === processing) this.processing = null;
      if (
        this.running &&
        this.generation === generation &&
        (!idleStarted || this.pendingMessages)
      ) {
        if (this.pollTimer || idleStarted) {
          void this.processNewMessages().catch((err) => {
            this.logger.error(err, "Error during initial IMAP poll");
          });
        } else {
          this.startPolling();
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    ++this.generation;
    this.processing = null;
    this.pendingMessages = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.failedUids.clear();
    this.sentUids.clear();
    this.initialized = false;
    this.initialUidMax = 0;
    this.uidValidity = null;
    await this.closeClient();
    this.logger.info("IMAP monitor stopped");
  }

  private async startIdle(client: ImapFlow, generation: number): Promise<void> {
    const lock = await client.getMailboxLock("INBOX");
    try {
      if (!this.isCurrent(client, generation)) return;
      this.existsHandler = () => {
        if (!this.isCurrent(client, generation)) return;
        void this.processNewMessages(true).catch((err) => {
          this.logger.error(err, "Error processing new IMAP messages");
        });
      };
      client.on("exists", this.existsHandler);
      await this.processUnseen(client, generation);
    } finally {
      lock.release();
    }
    if (!this.isCurrent(client, generation)) return;
    void client
      .idle()
      .then((result) => {
        if (result === false) this.disconnect(client, generation);
      })
      .catch((err) => {
        if (!this.isCurrent(client, generation)) return;
        this.logger.error(err, "IMAP IDLE failed, switching to polling");
        this.disconnect(client, generation);
      });
  }

  private startPolling(): void {
    if (!this.running || this.pollTimer) return;
    const intervalMs = (this.config.pollIntervalSec || 60) * 1000;
    this.pollTimer = setInterval(() => {
      void this.processNewMessages().catch((err) => {
        this.logger.error(err, "Error during IMAP poll");
      });
    }, intervalMs);
    this.pollTimer.unref();
    void this.processNewMessages().catch((err) => {
      this.logger.error(err, "Error during initial IMAP poll");
    });
  }

  private async processNewMessages(rerunIfBusy = false): Promise<void> {
    if (!this.running) return;
    if (this.processing) {
      if (rerunIfBusy) this.pendingMessages = true;
      return;
    }
    const processing = {};
    const generation = this.generation;
    this.processing = processing;
    try {
      do {
        this.pendingMessages = false;
        await this.processNewMessagesInner(generation);
      } while (this.running && this.generation === generation && this.pendingMessages);
    } finally {
      if (this.processing === processing) {
        this.processing = null;
        if (this.running && this.generation === generation && this.pendingMessages) {
          void this.processNewMessages().catch((err) => {
            this.logger.error(err, "Error processing pending IMAP messages");
          });
        }
      }
    }
  }

  private async processNewMessagesInner(generation: number): Promise<void> {
    let client = this.client;
    if (!client) {
      client = this.createClient(generation);
      this.client = client;
      try {
        await client.connect();
      } catch (err) {
        if (this.isCurrent(client, generation)) {
          this.logger.error(err, "IMAP reconnection failed");
          this.disconnect(client, generation);
        }
        return;
      }
    }
    if (!this.isCurrent(client, generation)) return;
    let lock;
    try {
      lock = await client.getMailboxLock("INBOX");
    } catch (err) {
      if (this.isCurrent(client, generation)) {
        this.logger.error(err, "IMAP mailbox lock failed, closing stale connection");
        this.disconnect(client, generation);
      }
      return;
    }
    try {
      if (this.isCurrent(client, generation)) await this.processUnseen(client, generation);
    } finally {
      lock.release();
    }
  }

  private async snapshotExistingUids(
    client: ImapFlow,
    generation: number,
    uidValidity: bigint,
  ): Promise<void> {
    if (!this.isCurrent(client, generation, uidValidity) || this.initialized) return;
    const uidNext = client.mailbox && client.mailbox.uidNext;
    const uidNextBaseline =
      typeof uidNext === "number" && Number.isSafeInteger(uidNext) && uidNext > 0
        ? uidNext - 1
        : null;
    // Some servers omit UIDNEXT; include read mail when deriving the initial boundary there.
    const uids = await client.search(uidNextBaseline === null ? { all: true } : { seen: false }, {
      uid: true,
    });
    if (!Array.isArray(uids)) throw new Error("IMAP initial UID search failed");
    if (!this.isCurrent(client, generation, uidValidity)) return;
    // Freeze the initial history boundary; the delivered-mail cache may be evicted independently.
    let initialUidMax = uidNextBaseline ?? 0;
    for (const uid of uids) initialUidMax = Math.max(initialUidMax, uid);
    this.initialUidMax = initialUidMax;
    this.initialized = true;
    const count = uids.length;
    if (count > 0) {
      this.logger.info(
        { count },
        uidNextBaseline === null
          ? "Skipped existing mailbox emails on first connect"
          : "Skipped existing unseen emails on first connect",
      );
    }
  }

  private async processUnseen(client: ImapFlow, generation: number): Promise<void> {
    if (!this.isCurrent(client, generation)) return;
    const uidValidity = client.mailbox && client.mailbox.uidValidity;
    if (typeof uidValidity !== "bigint" || uidValidity <= 0n) {
      throw new Error("IMAP mailbox UIDVALIDITY unavailable");
    }
    if (this.uidValidity !== uidValidity) {
      this.uidValidity = uidValidity;
      this.initialized = false;
      this.initialUidMax = 0;
      this.sentUids.clear();
      this.failedUids.clear();
    }

    // A changed UIDVALIDITY starts a new mailbox history boundary, even after reconnecting.
    if (!this.initialized) {
      await this.snapshotExistingUids(client, generation, uidValidity);
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
    // FIFO eviction: keep recent UIDs instead of clearing all to avoid re-sending
    if (this.sentUids.size > MAX_FAILED_UIDS) {
      const arr = [...this.sentUids];
      this.sentUids = new Set(arr.slice(-SENT_UIDS_KEEP));
    }

    const uids = await client.search({ seen: false }, { uid: true });
    if (!Array.isArray(uids)) throw new Error("IMAP unseen UID search failed");
    if (!this.isCurrent(client, generation, uidValidity)) return;
    const candidates = uids.filter(
      (uid) =>
        uid > this.initialUidMax &&
        !this.sentUids.has(uid) &&
        (this.failedUids.get(uid) ?? 0) < MAX_FAIL_RETRIES,
    );
    for (const uid of candidates) {
      if (!this.isCurrent(client, generation, uidValidity)) return;
      // Complete each FETCH before STORE; retain only one email's attachments in memory.
      const [msg] = await client.fetchAll([uid], { source: true, envelope: true }, { uid: true });
      if (!this.isCurrent(client, generation, uidValidity)) return;
      if (!msg) continue;
      try {
        if (!msg.source) continue;

        // Skip already-sent or exhausted UIDs
        if (msg.uid && this.sentUids.has(msg.uid)) continue;
        if (msg.uid && (this.failedUids.get(msg.uid) ?? 0) >= MAX_FAIL_RETRIES) continue;

        const parsed: ParsedMail = await simpleParser(msg.source);
        if (!this.isCurrent(client, generation, uidValidity)) return;
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

        if (!this.isCurrent(client, generation, uidValidity)) return;
        const result = await this.larkClient.sendCard(card);
        if (!this.running || this.generation !== generation || this.uidValidity !== uidValidity)
          return;
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
            if (this.isCurrent(client, generation, uidValidity)) {
              const marked = await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], {
                uid: true,
              });
              if (marked === false)
                this.logger.warn({ uid: msg.uid }, "Failed to mark email as seen");
            }
          } catch (flagErr) {
            this.logger.warn({ uid: msg.uid, err: flagErr }, "Failed to mark email as seen");
          }
          if (!this.running || this.generation !== generation || this.uidValidity !== uidValidity)
            return;
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
