// Strict argv allowlist for the Lody CLI subcommands the harness uses (lody 0.100.0 `--help`).
// Anything not listed here is rejected: no positional prompts, no `--env`, no `--debug`, no
// `--flag=value` spellings. `--wait --timeout <seconds>` is allowed on `session create` (human
// output, which prints the session id first) and on `session chat` with `--jsonl`, so the bridge
// can answer at acceptance and report the turn end through the app callback (waiter.mjs).

// A leading dash would be read as a flag, and the CLI then falls back to LODY_SESSION_ID.
const SESSION_ID = /^(?!-)[\w-]{1,128}$/;
const SELECTOR = /^[\w .:@/+-]{1,200}$/;
const MODEL = /^[\w.:[\]/+-]{1,120}$/;
// Only reasoning effort; other config options could change the agent's permissions.
const CONFIG_OPTION = /^(reasoning_effort|effort)=(default|low|medium|high|xhigh|max|ultra)$/;
const TEXT = /^[^\n\r]{1,200}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w./-]{1,200}$/;

/** @type {Record<string, RegExp>} */
const VALUE_RULES = {
  "--workspace": SELECTOR,
  "--machine": SELECTOR,
  "--agent": SELECTOR,
  "--agent-config": SELECTOR,
  "--local-project": SELECTOR,
  "--title": TEXT,
  "--repo": REPO,
  "--branch": BRANCH,
  "--mode": MODEL,
  "--model": MODEL,
  "--config-option": CONFIG_OPTION,
  "--prompt-file": /^-$/,
  "--turn-id": /^[\w:-]{1,160}$/,
  "--limit": /^([1-9]|1\d|20)$/,
  "--cursor": /^[\w+/=-]{1,4096}$/,
  "--timeout": /^[1-9]\d{1,4}$/,
};

const MAX_WAIT_SECONDS = 86_400;

const REPEATABLE = new Set(["--config-option"]);

/**
 * @typedef {{ path: string[]; session: boolean; values: string[]; flags: string[] }} CommandSpec
 * @type {CommandSpec[]}
 */
const COMMANDS = [
  { path: ["--version"], session: false, values: [], flags: [] },
  {
    path: ["machine", "list"],
    session: false,
    values: ["--workspace"],
    flags: ["--json", "--online-only"],
  },
  {
    path: ["agent-config", "list"],
    session: false,
    values: ["--workspace", "--machine", "--cursor"],
    flags: ["--json"],
  },
  {
    path: ["session", "create"],
    session: false,
    values: [
      "--workspace",
      "--machine",
      "--agent",
      "--agent-config",
      "--title",
      "--repo",
      "--local-project",
      "--branch",
      "--mode",
      "--model",
      "--config-option",
      "--prompt-file",
      "--timeout",
    ],
    flags: ["--worktree", "--json", "--wait"],
  },
  {
    path: ["session", "chat"],
    session: true,
    values: ["--workspace", "--mode", "--model", "--config-option", "--prompt-file", "--timeout"],
    flags: ["--json", "--jsonl", "--wait"],
  },
  {
    path: ["session", "show"],
    session: true,
    values: ["--workspace"],
    flags: ["--json", "--offline"],
  },
  {
    path: ["session", "status"],
    session: true,
    values: ["--workspace"],
    flags: ["--json", "--offline"],
  },
  // Read-only; the bridge trims the transcript to role, time, and text (server.mjs).
  {
    path: ["session", "history"],
    session: true,
    values: ["--workspace", "--limit"],
    flags: ["--json", "--reverse", "--offline"],
  },
  {
    path: ["session", "cancel"],
    session: true,
    values: ["--workspace", "--turn-id"],
    flags: ["--json"],
  },
  { path: ["session", "archive"], session: true, values: ["--workspace"], flags: ["--json"] },
];

/**
 * @param {unknown} args
 * @returns {{ ok: true; command: string; readsStdin: boolean; waits: boolean } | { ok: false; error: string }}
 */
export function checkArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 64) {
    return { ok: false, error: "args must be a non-empty array" };
  }
  if (!args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0"))) {
    return { ok: false, error: "args must be short strings" };
  }
  const spec = COMMANDS.find((candidate) =>
    candidate.path.every((segment, index) => args[index] === segment),
  );
  if (!spec) return { ok: false, error: "command not allowed" };
  const rest = args.slice(spec.path.length);
  let index = 0;
  if (spec.session) {
    if (!SESSION_ID.test(rest[0] ?? "")) return { ok: false, error: "session id required" };
    index = 1;
  }
  const seen = new Set();
  let readsStdin = false;
  for (; index < rest.length; index++) {
    const arg = rest[index];
    if (spec.flags.includes(arg)) {
      if (seen.has(arg)) return { ok: false, error: `duplicate ${arg}` };
      seen.add(arg);
      continue;
    }
    if (!spec.values.includes(arg))
      return { ok: false, error: `option not allowed: ${arg.slice(0, 40)}` };
    if (seen.has(arg) && !REPEATABLE.has(arg)) return { ok: false, error: `duplicate ${arg}` };
    seen.add(arg);
    const value = rest[++index];
    if (value === undefined || !VALUE_RULES[arg].test(value) || value.startsWith("--")) {
      return { ok: false, error: `invalid value for ${arg}` };
    }
    if (arg === "--prompt-file") readsStdin = true;
  }
  const command = spec.path.join(" ");
  const waitProblem = checkWait(command, seen, rest);
  if (waitProblem) return { ok: false, error: waitProblem };
  return { ok: true, command, readsStdin, waits: seen.has("--wait") };
}

/** The waiter reads a create's human output and a chat's JSON Lines; other shapes are refused. */
function checkWait(command, seen, rest) {
  const waits = seen.has("--wait");
  if (waits !== seen.has("--timeout")) return "--wait and --timeout go together";
  if (seen.has("--json") && seen.has("--jsonl")) return "--json and --jsonl are exclusive";
  if (!waits) return seen.has("--jsonl") ? "--jsonl only with --wait" : null;
  if (Number(rest[rest.indexOf("--timeout") + 1]) > MAX_WAIT_SECONDS) return "--timeout too long";
  if (command === "session create" && seen.has("--json")) return "--wait create uses human output";
  if (command === "session chat" && !seen.has("--jsonl")) return "--wait chat needs --jsonl";
  return null;
}
