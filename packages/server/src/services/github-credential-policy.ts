import { HTTPException } from "hono/http-exception";
import { ownerOrAdmin } from "../middleware/better-auth.js";

export interface ExistingGitHubCredential {
  login?: string;
}

export interface IncomingGitHubCredential {
  token?: string;
  login?: string;
}

export interface GitHubCodingProvider {
  id: string;
  encryptedApiKey?: string | null;
  defaultModel: string;
  models?: { id: string }[];
}

export function assertGitHubCodingModelSelection(
  providers: GitHubCodingProvider[],
  providerId?: string,
  modelId?: string,
): void {
  if (!providerId) {
    if (modelId) {
      throw new HTTPException(400, {
        message: "配置 GitHub Coding 模型时必须同时选择服务商",
      });
    }
    return;
  }

  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new HTTPException(400, {
      message: `GitHub Coding 服务商不存在：${providerId}`,
    });
  }
  if (!provider.encryptedApiKey) {
    throw new HTTPException(400, {
      message: `GitHub Coding 服务商尚未配置 API Key：${providerId}`,
    });
  }

  const resolvedModel = modelId ?? provider.defaultModel;
  if (
    !resolvedModel ||
    (resolvedModel !== provider.defaultModel &&
      !provider.models?.some((candidate) => candidate.id === resolvedModel))
  ) {
    throw new HTTPException(400, {
      message: `GitHub Coding 模型不属于所选服务商：${resolvedModel || "（未配置）"}`,
    });
  }
}

export function assertGitHubCredentialUpdateAllowed(
  role: string,
  existing: ExistingGitHubCredential | undefined,
  incoming: IncomingGitHubCredential,
): void {
  const changesCredential =
    !!incoming.token ||
    (incoming.login !== undefined && (incoming.login || undefined) !== existing?.login);
  if (changesCredential && !ownerOrAdmin.has(role)) {
    throw new HTTPException(403, {
      message: "只有 owner 或 admin 可以修改 GitHub 凭据",
    });
  }
}

export class GitHubCredentialGenerationGate {
  private readonly generations = new Map<string, number>();

  invalidate(botId: string): void {
    this.generations.set(botId, this.current(botId) + 1);
  }

  capture(
    botId: string,
    resolveCredential: () => Promise<string | undefined>,
  ): () => Promise<string | undefined> {
    const generation = this.current(botId);
    return async () => {
      this.assertCurrent(botId, generation);
      const credential = await resolveCredential();
      this.assertCurrent(botId, generation);
      return credential;
    };
  }

  private current(botId: string): number {
    return this.generations.get(botId) ?? 0;
  }

  private assertCurrent(botId: string, expected: number): void {
    if (this.current(botId) !== expected) {
      throw new Error("GitHub credentials changed; retry after the bot restarts");
    }
  }
}
