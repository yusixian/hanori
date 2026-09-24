import { z } from "zod";
import { EFFORTS, modelOptionSchema } from "./execution.js";
import { durationSchema, percentSchema } from "./units.js";

export const RISK_TIERS = ["T0", "T1", "T2", "T3"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
export const PROJECT_KINDS = ["web", "electron", "native", "service", "library"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

const tierSchema = z.enum(RISK_TIERS);
const globList = z.array(z.string().min(1));
const existingThread = z.string().regex(/^existing:\d+$/, "应为 existing:<thread id>");
const threadId = z.number().int().positive();
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "应为环境变量名");

const telegramSchema = z.strictObject({
  bot: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  chatId: z.number().int().negative("应为超级群 ID（负数）"),
  owners: z.array(z.number().int().positive()).min(1, "至少需要一个 owner"),
  topics: z
    .strictObject({
      overview: z.union([z.literal("general"), threadId]).default("general"),
      alerts: z.union([threadId, existingThread]).nullable().default(null),
      featureTopics: z.enum(["off", "suggest", "always"]).default("suggest"),
      closeFeatureTopicOnDone: z.boolean().default(true),
      titleFormat: z.string().min(1).default("{project} · #{issue} {title}"),
    })
    .prefault({}),
  chat: z
    .strictObject({
      casualReplies: z.boolean().default(false),
      triage: z.boolean().default(true),
    })
    .prefault({}),
  cards: z
    .strictObject({
      language: z.enum(["zh-CN", "en"]).default("zh-CN"),
      screenshot: z.enum(["none", "first"]).default("first"),
      showDuration: z.boolean().default(true),
      showQuota: z.boolean().default(true),
      showContext: z.boolean().default(true),
      showFiles: z.boolean().default(false),
      summary: z.enum(["ai", "title"]).default("ai"),
    })
    .prefault({}),
  notify: z
    .strictObject({
      preview: z.enum(["each", "silent", "digest"]).default("digest"),
      digestAt: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "应为 HH:mm")
        .default("21:00"),
      timezone: z.string().min(1).default("Asia/Shanghai"),
      quietHours: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, "应为 HH:mm-HH:mm")
        .nullable()
        .default(null),
      mentionOnAction: z.boolean().default(true),
      digestQuota: z.boolean().default(true),
    })
    .prefault({}),
});

const approvalsSchema = z
  .strictObject({
    ttl: durationSchema.default("7d"),
    stableConfirm: z.enum(["once", "twice"]).default("twice"),
    rollbackConfirm: z.enum(["once", "twice"]).default("twice"),
    mergeConfirm: z.enum(["once", "twice"]).default("once"),
  })
  .prefault({});

const executorsSchema = z
  .strictObject({
    default: z.enum(["lody", "node"]).default("lody"),
    lody: z
      .strictObject({
        cli: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).default("lody"),
        timeout: durationSchema.default("20s"),
        workspace: z.string().min(1).default("auto"),
        agentConfig: z.string().min(1).default("Codex"),
        /** Replaces the built-in model list of an agent type (e.g. `codex`) in the GUI. */
        models: z.record(z.string().min(1), z.array(modelOptionSchema).min(1)).default({}),
        worktree: z.boolean().default(true),
        shareLinks: z.boolean().default(true),
        // Values stay in the environment; YAML only names the variables.
        bridge: z
          .strictObject({
            urlEnv: envName.default("HARNESS_LODY_BRIDGE_URL"),
            secretEnv: envName.default("HARNESS_LODY_BRIDGE_SECRET"),
          })
          .prefault({}),
        sessionUrl: z
          .string()
          .regex(/^https:\/\/[^\s]*\{sessionId\}[^\s]*$/, "应为包含 {sessionId} 的 https 链接")
          .nullable()
          .default(null),
        poll: z
          .strictObject({
            active: durationSchema.default("20s"),
            idle: durationSchema.default("2m"),
          })
          .prefault({}),
      })
      .prefault({}),
    node: z
      .strictObject({
        enabled: z.boolean().default(false),
        listen: z.enum(["tailnet", "public"]).default("tailnet"),
      })
      .prefault({}),
  })
  .prefault({});

const machineSchema = z.strictObject({
  lody: z.string().min(1),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const roleSchema = z.strictObject({
  executor: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
});

/**
 * Applied as the lowest layer, so a partial `roles` in YAML or the panel keeps the rest. The
 * worker's model defaults per vendor, and subworker/reviewer follow the lead (execution.ts).
 */
export const DEFAULT_ROLES = {
  triage: { model: "sonnet", effort: "low" },
  planner: { model: "opus", effort: "high" },
  worker: { effort: "high" },
} as const;

const rolesSchema = z.record(z.string().min(1), roleSchema).default(() => ({ ...DEFAULT_ROLES }));

const guardrailsSchema = z
  .strictObject({
    concurrency: z
      .strictObject({
        perMachine: z.number().int().positive().default(4),
        perProject: z.number().int().positive().default(3),
        sameAreaWriters: z.number().int().positive().default(1),
      })
      .prefault({}),
    time: z
      .strictObject({
        idleRemindAfter: durationSchema.default("45m"),
        runRemindAfter: durationSchema.default("6h"),
        hardCancelAfter: durationSchema.nullable().default(null),
      })
      .prefault({}),
    autoFixRounds: z.number().int().min(0).max(10).default(2),
    quota: z
      .strictObject({
        pauseAt: z
          .strictObject({
            fiveHour: percentSchema.default("95%"),
            week: percentSchema.default("90%"),
          })
          .prefault({}),
        warnAt: z.strictObject({ week: percentSchema.default("75%") }).prefault({}),
        fallback: z.record(z.string().min(1), z.string().min(1)).default({}),
        dailySessionCap: z.number().int().positive().nullable().default(null),
      })
      .prefault({}),
    autonomy: z
      .strictObject({
        bugStartsImmediately: z.boolean().default(true),
        triageStartsWork: z.boolean().default(false),
        autoMergeTiers: z.array(tierSchema).default([]),
      })
      .prefault({}),
  })
  .prefault({});

const githubSchema = z
  .strictObject({
    acceptIssues: z.enum(["harness-only", "all"]).default("harness-only"),
    acceptPullRequests: z.enum(["harness-only", "all"]).default("harness-only"),
    trustedAuthors: z.array(z.string().min(1)).default([]),
    mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
    deleteBranchOnMerge: z.boolean().default(true),
    requireChecks: z.enum(["all", "required"]).default("all"),
    branchPrefix: z.string().min(1).default("harness/"),
    labelPrefix: z.string().min(1).default("harness:"),
    webhookSecretEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "应为环境变量名")
      .default("HARNESS_GITHUB_WEBHOOK_SECRET"),
  })
  .prefault({});

const controlDeploySchema = z
  .strictObject({
    dokploy: z
      .strictObject({
        url: z.url().nullable().default(null),
        apiKeyEnv: z.string().min(1).default("DOKPLOY_API_KEY"),
      })
      .prefault({}),
    healthTimeout: durationSchema.default("5m"),
    pinOnRollback: z.boolean().default(true),
  })
  .prefault({});

const controlReleaseSchema = z
  .strictObject({
    stableReminder: z
      .union([z.enum(["off", "weekly"]), z.string().regex(/^changes:\d+$/)])
      .default("weekly"),
    candidateMinChanges: z.number().int().positive().default(1),
  })
  .prefault({});

const auditSchema = z.strictObject({ retain: durationSchema.default("365d") }).prefault({});

const controlShape = {
  telegram: telegramSchema,
  approvals: approvalsSchema,
  executors: executorsSchema,
  machines: z.record(z.string().min(1), machineSchema).default({}),
  roles: rolesSchema,
  guardrails: guardrailsSchema,
  github: githubSchema,
  deploy: controlDeploySchema,
  release: controlReleaseSchema,
  audit: auditSchema,
};

/** Global fields a project entry in harness.yaml may override. */
export const PROJECT_OVERRIDABLE_KEYS = [
  "approvals",
  "executors",
  "roles",
  "guardrails",
  "github",
  "deploy",
  "release",
] as const;

export const projectTopicSchema = z
  .union([z.literal("auto"), threadId, existingThread])
  .default("auto");

export const DEFAULT_PREFER_SKILLS = [
  "oneshot",
  "frontend-acceptance",
  "gh-stack",
  "pr-visual",
  "review-code-change",
];

export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const projectBindingShape = {
  repo: z.string().regex(REPO_PATTERN, "应为 owner/name"),
  topic: projectTopicSchema,
  machines: z.array(z.string().min(1)).default([]),
  localProject: z.string().min(1).optional(),
};

const projectEntrySchema = z.strictObject({
  ...projectBindingShape,
  ...Object.fromEntries(PROJECT_OVERRIDABLE_KEYS.map((key) => [key, z.unknown().optional()])),
});

export const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const harnessFileSchema = z.strictObject({
  version: z.literal(1),
  ...controlShape,
  projects: z
    .record(
      z
        .string()
        .regex(PROJECT_KEY_PATTERN, "项目名只能包含小写字母、数字、- 和 _")
        .refine((key) => key !== "global", "global 是保留名"),
      projectEntrySchema,
    )
    .default({}),
});

export const repoPolicySchema = z.strictObject({
  version: z.literal(1).default(1),
  kind: z.enum(PROJECT_KINDS).default("web"),
  verify: z
    .strictObject({
      quick: z.string().min(1).nullable().default(null),
      full: z.string().min(1).nullable().default(null),
      acceptance: z.string().min(1).nullable().default(null),
      timeout: durationSchema.default("30m"),
    })
    .prefault({}),
  sizeGate: z
    .strictObject({
      maxFiles: z.number().int().positive().default(5),
      forbidTiers: z.array(tierSchema).default(["T3"]),
      forbidCrossPackages: z.boolean().default(false),
    })
    .prefault({}),
  areas: z.record(z.string().min(1), globList).default({}),
  risk: z
    .strictObject({
      default: tierSchema.default("T2"),
      T0: globList.default(["docs/**", "**/*.md", "**/locales/**"]),
      T1: globList.default([]),
      T2: globList.default([]),
      T3: globList.default([]),
    })
    .prefault({}),
  contract: z
    .strictObject({
      releaseFragment: z.enum(["required", "optional"]).default("required"),
      sections: z.array(z.string().min(1)).default(["verify", "review"]),
      screenshots: z.enum(["always", "when-ui", "never"]).default("when-ui"),
      uiPaths: globList.default(["apps/**/src/**/*.tsx"]),
      review: z
        .strictObject({
          by: z.enum(["lead", "server"]).default("lead"),
          reverify: z.boolean().default(false),
        })
        .prefault({}),
      flags: z
        .strictObject({
          staleEvidence: z.boolean().default(true),
          testDeletion: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  release: z
    .strictObject({
      tool: z.literal("release-kit").default("release-kit"),
      preview: z
        .strictObject({
          trigger: z.enum(["merge", "manual", "daily", "none"]).default("none"),
          workflow: z.string().min(1).nullable().default(null),
        })
        .prefault({}),
      stable: z
        .strictObject({
          approval: z.enum(["owner", "auto"]).default("owner"),
          workflow: z.string().min(1).default("release.yml"),
        })
        .prefault({}),
    })
    .prefault({}),
  docs: z
    .strictObject({
      paths: globList.default([]),
      requiredFor: z
        .array(z.enum(["fix", "feat", "breaking", "internal"]))
        .default(["feat", "breaking"]),
    })
    .prefault({}),
  deploy: z
    .strictObject({
      target: z.enum(["none", "dokploy", "github-release", "vercel"]).default("none"),
      onMerge: z.enum(["production", "staging", "none"]).default("none"),
      application: z.string().min(1).nullable().default(null),
      image: z.string().min(1).nullable().default(null),
      health: z.url().nullable().default(null),
    })
    .prefault({}),
  prompts: z
    .strictObject({
      extra: z.array(z.string().min(1)).default([]),
      // Overrides must live under .cos/, whose changes are fixed at T3.
      templates: z
        .partialRecord(
          z.enum(["bug", "revise", "answer", "ci_failed"]),
          z
            .string()
            .regex(/^\.cos\/[\w./-]+\.md$/, "模板必须是 .cos/ 下的 .md 文件")
            .refine((path) => !path.includes(".."), "模板路径不能包含 .."),
        )
        .default({}),
      preferSkills: z.array(z.string().min(1)).default(() => [...DEFAULT_PREFER_SKILLS]),
    })
    .prefault({}),
});

export const projectEffectiveSchema = z.strictObject({
  ...controlShape,
  project: z.strictObject({ key: z.string(), ...projectBindingShape }),
  policy: repoPolicySchema,
});

export type HarnessFileConfig = z.infer<typeof harnessFileSchema>;
export type RepoPolicy = z.infer<typeof repoPolicySchema>;
export type ProjectEffectiveConfig = z.infer<typeof projectEffectiveSchema>;

const KIND_DEFAULTS: Record<
  ProjectKind,
  {
    target: RepoPolicy["deploy"]["target"];
    onMerge: RepoPolicy["deploy"]["onMerge"];
    trigger: RepoPolicy["release"]["preview"]["trigger"];
    idleRemindAfter: string;
  }
> = {
  web: { target: "dokploy", onMerge: "production", trigger: "none", idleRemindAfter: "45m" },
  electron: { target: "github-release", onMerge: "none", trigger: "merge", idleRemindAfter: "90m" },
  native: { target: "github-release", onMerge: "none", trigger: "manual", idleRemindAfter: "90m" },
  service: { target: "dokploy", onMerge: "production", trigger: "none", idleRemindAfter: "45m" },
  library: { target: "none", onMerge: "none", trigger: "manual", idleRemindAfter: "45m" },
};

/** Raw layer applied just above built-in defaults for the project's effective tree. */
export function kindDefaultsLayer(kind: ProjectKind): Record<string, unknown> {
  const defaults = KIND_DEFAULTS[kind];
  return {
    guardrails: { time: { idleRemindAfter: defaults.idleRemindAfter } },
    policy: {
      deploy: { target: defaults.target, onMerge: defaults.onMerge },
      release: { preview: { trigger: defaults.trigger }, stable: { approval: "owner" } },
    },
  };
}

export function resolveThreadSetting(
  value: string | number,
): { mode: "auto" } | { mode: "fixed"; threadId: number } {
  if (typeof value === "number") return { mode: "fixed", threadId: value };
  if (value.startsWith("existing:")) return { mode: "fixed", threadId: Number(value.slice(9)) };
  return { mode: "auto" };
}
