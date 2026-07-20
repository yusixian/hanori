# Pi coding agent

The optional coding worker embeds [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi)
as an isolated, credential-free coding process. It is intentionally separate from the main bot
container because Pi's SDK adds roughly 128 MB of resident memory when loaded, while active coding
and repository builds can require substantially more.

## Security model

- Only bot administrators receive the coding and push tools.
- The main server owns the GitHub token. It performs authenticated clone, fetch, and push operations
  with a temporary `GIT_ASKPASS` environment and restores the canonical GitHub remote before every
  authenticated operation.
- Git metadata and remotes live in a separate volume mounted read-only in the worker. Pi can inspect
  status and diffs but cannot edit `.git` configuration, hooks, or authenticated remotes.
- Pi receives a workspace path, task, and the selected language-model credential. It never receives
  the GitHub token.
- Pi may read, edit, write, and run shell commands only inside a separate container with a read-only
  root filesystem, no added Linux capabilities, no Docker socket, and a 1 GiB memory limit.
- The trusted server configures Ai-chan's Git author identity, creates the local branch, and creates a
  local commit after Pi finishes. Push is a separate one-time Telegram confirmation bound to the
  initiating administrator, chat, branch, and exact commit SHA.
- Ordinary members keep only the anonymous public-repository read tools.

Pi itself does not provide a sandbox. The container boundary is therefore required; do not run the
worker directly on a host containing secrets or unrelated workspaces.

## Start the worker

Generate a shared internal secret and put it in `.env`:

```bash
CODING_WORKER_SECRET=$(openssl rand -hex 32)
```

Start production Compose with the optional profile:

```bash
docker compose --profile coding up -d --build
```

Then enable **GitHub identity and code access** and **Pi coding agent** in the bot's AI settings.
The worker is lazy-loaded: while idle it runs only the small HTTP shell; the Pi SDK is imported when
the first job starts. Jobs are serialized and have a four-minute timeout so they complete inside the
default five-minute AI reply budget.

For local development, run the worker separately with the same secret and workspace directory:

```bash
CODING_WORKER_SECRET=dev-secret \
CODING_WORKSPACES_DIR=./data/code-workspaces \
pnpm dev:coding-worker
```

The first version targets Node-based repositories because the worker image includes Node, pnpm,
Git, Bash, and ripgrep. Other build toolchains can be added to the worker image without expanding
the main bot image or giving Pi more GitHub authority.

## Resource footprint

The worker image is roughly 500 MB in the current build. The main application image excludes Pi's
runtime dependency graph, so this disk cost applies only when the optional worker is built. The idle HTTP shell does not import Pi;
loading the SDK added about 128 MB RSS in a local measurement. Active coding usually needs
300–800 MB, while a repository build can approach the configured 1 GiB container limit. Compose
also limits the worker to 1.5 CPU cores.

Each repository keeps package-manager downloads in an ignored `.cos-pi-cache/` directory inside
its own workspace, so one repository cannot persist package-manager configuration into another.
These caches and cloned repositories live in the `codeworkspaces` volume and can grow over time;
inspect them with `docker system df -v` and prune individual stale workspaces during maintenance.
