import type { Database } from "@cos-tool-bot/database";
import { settings } from "@cos-tool-bot/database";
import { and, eq, like } from "drizzle-orm";

const PREFIX = "github-issue-proposal:v1:";

export interface GitHubIssueProposalStore {
  insert(botId: string, id: string, value: string): Promise<void>;
  get(botId: string, id: string): Promise<string | undefined>;
  list(botId: string): Promise<string[]>;
  compareExchange(botId: string, id: string, previous: string, next: string): Promise<boolean>;
}

/** One immutable descriptor per key; the complete stored value is the CAS revision. */
export class SettingsGitHubIssueProposalStore implements GitHubIssueProposalStore {
  constructor(private readonly db: Database) {}

  private key(botId: string, id: string) {
    if (!/^[\da-f-]{36}$/.test(botId) || !/^[\da-f]{24}$/.test(id)) {
      throw new Error("Invalid GitHub proposal key");
    }
    return `${PREFIX}${botId}:${id}`;
  }

  async insert(botId: string, id: string, value: string) {
    const key = this.key(botId, id);
    await this.persist(() => this.db.insert(settings).values({ key, value }));
  }

  async get(botId: string, id: string) {
    const key = this.key(botId, id);
    const [row] = await this.persist(() =>
      this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)),
    );
    return row?.value;
  }

  async list(botId: string) {
    this.key(botId, "0".repeat(24));
    const rows = await this.persist(() =>
      this.db
        .select({ value: settings.value })
        .from(settings)
        .where(like(settings.key, `${PREFIX}${botId}:%`)),
    );
    return rows.map((row) => row.value);
  }

  async compareExchange(botId: string, id: string, previous: string, next: string) {
    const key = this.key(botId, id);
    const rows = await this.persist(() =>
      this.db
        .update(settings)
        .set({ value: next })
        .where(and(eq(settings.key, key), eq(settings.value, previous)))
        .returning({ key: settings.key }),
    );
    return rows.length === 1;
  }

  private async persist<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      // Drizzle errors can contain the full JSON descriptor in SQL parameters.
      throw new Error("GitHub 提案存储暂不可用；请稍后核实，不要重发创建请求");
    }
  }
}
