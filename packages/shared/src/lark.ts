export interface LarkWebhookConfig {
  webhookUrl: string;
  encryptedSignSecret?: string;
}

export interface EmailForwardFilter {
  senderPattern?: string;
  subjectPattern?: string;
}

export const ALL_EMAIL_EVENT_TYPES = [
  "pr:approved",
  "pr:changes_requested",
  "pr:commented",
  "pr:merged",
  "pr:opened",
  "pr:review_requested",
  "pr:pushed",
  "pr:unknown",
  "ci:failed",
  "ci:cancelled",
  "ci:succeeded",
  "ci:completed",
  "issue:opened",
  "issue:closed",
  "issue:commented",
  "issue:unknown",
  "generic",
] as const;

export type EmailEventType = (typeof ALL_EMAIL_EVENT_TYPES)[number];

export interface EmailForwardConfig {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  email: string;
  encryptedPassword: string;
  pollIntervalSec: number;
  filters: EmailForwardFilter[];
  larkMentionMap?: Record<string, string>;
  disabledEventTypes?: EmailEventType[];
}

export interface EmailForwardConfigPublic {
  imapHost: string;
  imapPort: number;
  email: string;
  pollIntervalSec: number;
  filters: EmailForwardFilter[];
  larkMentionMap?: Record<string, string>;
  disabledEventTypes?: EmailEventType[];
  hasPassword: boolean;
}

// Instance-specific identities belong in each Bot's saved email configuration.
export const DEFAULT_LARK_MENTION_MAP: Record<string, string> = {};
