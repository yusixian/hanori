import type { MediaJobStage, TranscriptDocument } from "@cos-tool-bot/shared";
import type { mediaTranscriptionJobs } from "@cos-tool-bot/database";

export type MediaJobRow = typeof mediaTranscriptionJobs.$inferSelect;
export interface MediaJobConfiguration {
  revision: number;
  installationRevision: number;
  cookie?: string;
  asr: { baseUrl: string; apiKey: string; model: string; language?: string };
  limits: {
    maxDurationSeconds: number;
    dailyJobs: number;
    dailyMinutes: number;
    costPerMinute: number;
    maxDailyCost: number;
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
  /** Returns null unless the trusted plugin is installed, enabled, reviewed and ASR consent configured. */
  configuration(botId: string): Promise<MediaJobConfiguration | null>;
  inspect(
    sourceUrl: string,
    configuration: MediaJobConfiguration,
    signal: AbortSignal,
  ): Promise<InspectedMediaResource>;
  execute(
    job: MediaJobRow,
    configuration: MediaJobConfiguration,
    options: { signal: AbortSignal; onStage(stage: MediaJobStage): Promise<void> },
  ): Promise<TranscriptDocument>;
  /** Only sends a completion notice with job ID; do not deliver transcript contents here. */
  notify?(job: MediaJobRow): Promise<void>;
  cleanup?(jobId: string, attempt: number): Promise<void>;
}
