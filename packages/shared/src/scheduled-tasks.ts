/** Overrides inherit current Bot task-Agent defaults at execution time. No credentials are stored here. */
export interface AgentExecutionConfig {
  providerId?: string;
  modelId?: string;
  systemPrompt?: string;
  toolNames?: string[];
  timeoutMs?: number;
  maxSteps?: number;
}

export type TaskSchedule =
  | { kind: "once"; at: string; timezone: string }
  | { kind: "interval"; startsAt: string; everySeconds: number; timezone: string }
  | {
      kind: "calendar";
      startsAt: string;
      timezone: string;
      period: "week" | "month" | "quarter";
      hour: number;
      minute: number;
      weekday?: number;
      dayOfMonth?: number;
    };

export interface ScheduledTaskPlan {
  name: string;
  instructions: string;
  dataScope: { kind: "none" | "chat"; lookbackHours?: number; maxMessages?: number };
  destination: { chatId: number; threadId?: number };
  schedule: TaskSchedule;
  agentName?: string;
  agent: AgentExecutionConfig;
}

export interface ScheduledTaskActor {
  botId: string;
  chatId: number;
  threadId?: number;
  userId: number;
  userName?: string;
  isAdmin: boolean;
  isBotAdmin?: boolean;
}
export type ScheduledTaskStatus = "pending" | "active" | "paused" | "completed" | "cancelled";
export interface ScheduledTaskRecord {
  id: string;
  botId: string;
  chatId: number;
  threadId: number | null;
  proposerId: number;
  approvedByUserId: number | null;
  proposerName: string;
  activePlan: ScheduledTaskPlan | null;
  pendingPlan: ScheduledTaskPlan | null;
  revision: number;
  pendingVersion: number | null;
  expiresAt: string | null;
  confirmationMessageId: number | null;
  status: ScheduledTaskStatus;
  nextRunAt: string | null;
  runningRunId: string | null;
  consecutiveFailures: number;
  createdAt: string;
  latestRun?: ScheduledTaskRun | null;
}
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  trial: boolean;
  manual?: boolean;
  messageIds?: number[];
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  plan: ScheduledTaskPlan;
  agent: AgentExecutionConfig;
  output: string | null;
  error: string | null;
}
export interface ScheduledTaskDecision {
  id: string;
  version: number;
  messageId?: number;
  action: "approve" | "trial" | "cancel";
}
export interface ScheduledTaskPort {
  propose(
    actor: ScheduledTaskActor,
    plan: ScheduledTaskPlan,
    taskId?: string,
  ): Promise<ScheduledTaskRecord>;
  bindConfirmation(
    actor: ScheduledTaskActor,
    id: string,
    version: number,
    messageId: number,
  ): Promise<void>;
  decide(actor: ScheduledTaskActor, decision: ScheduledTaskDecision): Promise<ScheduledTaskRecord>;
  get(actor: ScheduledTaskActor, id: string): Promise<ScheduledTaskRecord | null>;
  list(actor: ScheduledTaskActor): Promise<ScheduledTaskRecord[]>;
  runs(actor: ScheduledTaskActor, id: string): Promise<ScheduledTaskRun[]>;
  manage(
    actor: ScheduledTaskActor,
    id: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<ScheduledTaskRecord>;
  getPendingDiscussion(
    actor: ScheduledTaskActor,
    replyToMessageId?: number,
  ): Promise<ScheduledTaskRecord | null>;
}
