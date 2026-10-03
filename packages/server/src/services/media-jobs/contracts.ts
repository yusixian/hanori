import type {
  MediaJobActor,
  MediaJobStage,
  MediaJobView,
  TranscriptDocument,
} from "@cos-tool-bot/shared";
import type { mediaTranscriptionJobs } from "@cos-tool-bot/database";

export type MediaJobRow = typeof mediaTranscriptionJobs.$inferSelect;
export interface MediaJobConfiguration {
  revision: number;
  installationRevision: number;
  cookie?: string;
  asr: {
    baseUrl: string;
    apiKey: string;
    model: string;
    language?: string;
    provider?: "tencent" | "aliyun" | "groq" | "openai";
    secretId?: string;
    secretKey?: string;
    region?: string;
  };
  providerRevision?: number;
  providerAccount?: string;
  currency?: "CNY" | "USD";
  freeQuota?: string;
  freeAllowanceMinutes?: number;
  freeAllowancePeriod?: "month" | "day" | "none";
  limits: {
    maxDurationSeconds: number;
    dailyJobs: number;
    dailyMinutes: number;
    costPerMinute: number;
    maxDailyCost: number;
    maxPerJobCost?: number;
    accountDailyCost?: number;
    accountMonthlyCost?: number;
    accountMonthlyMinutes?: number;
    monthlyMinutes?: number;
    maxMonthlyCost?: number;
    botMonthlyMinutes?: number;
    botMaxMonthlyCost?: number;
  };
  allowExport: boolean;
}
export interface InspectedMediaResource {
  canonicalUrl: string;
  bvid: string;
  part: number;
  title: string;
  durationSeconds: number;
  hasSubtitles: boolean;
}
export interface MediaJobDependencies {
  authorize?(actor: MediaJobActor): Promise<boolean>;
  requestConfirmation?(job: MediaJobView, actor: MediaJobActor): Promise<void>;
  /** Returns null unless the trusted plugin is installed, enabled, reviewed and ASR consent configured. */
  configuration(botId: string, providerAccount?: string): Promise<MediaJobConfiguration | null>;
  /** Ordered configured accounts. Selection happens before confirmation, never after submission. */
  configurations?(botId: string): Promise<MediaJobConfiguration[]>;
  inspect(
    sourceUrl: string,
    configuration: MediaJobConfiguration,
    signal: AbortSignal,
  ): Promise<InspectedMediaResource>;
  execute(
    job: MediaJobRow,
    configuration: MediaJobConfiguration,
    options: {
      signal: AbortSignal;
      onStage(stage: MediaJobStage): Promise<void>;
      onProviderTask?(id: string): Promise<void>;
    },
  ): Promise<TranscriptDocument>;
  /** Queries a known provider task after restart without resubmitting audio. */
  resume?(
    job: MediaJobRow,
    configuration: MediaJobConfiguration,
    signal: AbortSignal,
  ): Promise<TranscriptDocument>;
  /** Only sends a completion notice with job ID; do not deliver transcript contents here. */
  notify?(job: MediaJobRow): Promise<void>;
  cleanup?(jobId: string, attempt: number): Promise<void>;
  sweep?(): Promise<void>;
}
