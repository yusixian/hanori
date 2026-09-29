export interface ChatAiSelectionRecord {
  botId: string;
  chatId: number;
  providerId: string;
  modelId: string | null;
  revision: number;
  updatedByKind: "telegram_user" | "better_auth_user" | null;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatAiSelectionMigrationOutcome =
  | "migrated_pair"
  | "migrated_provider_default"
  | "inherited"
  | "ignored";

export type ChatAiSelectionMigrationReason =
  | "provider_only_valid"
  | "provider_only_invalid_provider"
  | "model_only_valid"
  | "model_only_no_effective_provider"
  | "model_only_invalid_model"
  | "pair_valid"
  | "pair_invalid_model_provider_default"
  | "pair_invalid_provider"
  | "non_group_chat"
  | "unsafe_chat_id";

export interface ChatAiSelectionMigrationReportRecord {
  botId: string;
  chatId: number;
  legacyProviderId: string | null;
  legacyModelId: string | null;
  effectiveProviderId: string | null;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  outcome: ChatAiSelectionMigrationOutcome;
  reason: ChatAiSelectionMigrationReason;
  migratedAt: string;
}
