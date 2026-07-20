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
- The worker never mounts canonical workspaces or Git metadata. After a fail-closed clean-index
  check, the server materializes exactly the tracked Git index with `git checkout-index` into a
  fixed single-job staging volume. Ignored `.env` files, caches, and other untracked legacy
  artifacts are never staged. Executable bits and safe relative symlinks are preserved.
- Staging rejects absolute or traversing symlinks, special files, excessive file counts, and
  excessive total bytes before and after Pi runs. The shared `codingjob` volume is also a 1 GiB
  tmpfs enforced by the container runtime, so writes fail at the mount boundary before they can
  exhaust the Docker host disk. The result is checked again before trusted Git metadata is used to
  create a commit and reset the canonical clean worktree to that commit.
- Pi may read, edit, write, and run shell commands only inside a separate container with a read-only
  root filesystem, no added Linux capabilities, no Docker socket, a PID limit, and a 1 GiB memory
  limit. The worker joins only the internal `coding-sandbox` network, which has no external route.
  Model requests, Node global `fetch`, and proxy-aware shell/package tools use the separate Squid
  sidecar. Only that sidecar joins `coding-egress`; its DNS-aware ACL denies localhost, private,
  CGNAT, link-local, multicast, special-purpose, and metadata destinations for HTTP/HTTPS traffic.
- The app and worker communicate over a mode-0770 tmpfs Unix-socket volume. The worker secret is
  removed from its environment and never written to that shared volume. Each worker handles one
  accepted job, exits after flushing the response, and is restarted by Compose. For every health
  poll the server generates a fresh random challenge and accepts the new boot only when its boot ID
  and challenge carry a timing-safe verified HMAC. A detached process that replaces the socket can
  see the challenge but cannot forge or replay the restart proof.
- The trusted server configures Ai-chan's Git author identity, creates the local branch, and creates a
  local commit after Pi finishes. Push is a separate one-time Telegram confirmation bound to the
  initiating administrator, chat, branch, and exact commit SHA.
- After the branch is pushed, an administrator can separately propose a same-repository pull request.
  The trusted bot resolves head and base, binds confirmation to the exact remote head SHA, and
  rechecks it before creating or idempotently returning an existing open pull request. Pi never
  receives the GitHub token or creates the pull request itself.
- Confirmed push, pull-request, and Issue mutations carry the runtime cancellation signal through
  every Git or GitHub request, combined with a 30-second GitHub HTTP timeout. Cancellation cannot
  prove that a remote server did not accept an in-flight mutation, so interruption errors explicitly
  require checking GitHub before retrying.
- Ordinary members keep only the anonymous public-repository read tools.

### Interrupted workspace recovery

The normal `github_code_task` path still fails closed when its canonical workspace is dirty. An
administrator can use `github_inspect_workspace` to see the branch, HEAD, and concise changed-path
summary without exposing ignored `.env` files or caches. The trusted server also computes a private
state fingerprint over the branch, HEAD, Git index/status, tracked content and deletions, and
non-ignored untracked files, including executable and symlink metadata. The model cannot provide or
override that fingerprint.

Two explicit recovery actions are available when the coding worker and model are configured:

- `github_resume_workspace` captures the current dirty state itself and proposes a ten-minute,
  one-time Telegram confirmation bound to the requesting administrator and chat. On confirmation,
  the server locks and rechecks the exact state, materializes that snapshot in the isolated staging
  slot, lets Pi finish the requested task, and commits the complete result. Worker failure or
  cancellation leaves the canonical workspace dirty for another recovery attempt. If a failure
  occurs after the trusted server changes the index, commit, or canonical worktree, it restores the
  original branch ref, raw index, and worktree from a bounded Git-tree checkpoint before reporting
  the failure. Staging is always cleaned. Gitlinks/submodules fail closed because they cannot be
  represented safely by this recovery flow.
- `github_discard_workspace` uses the same internal inspection and exact-state confirmation. On
  confirmation, it resets to the captured HEAD and removes only the exact non-ignored untracked
  paths bound by that inspection, using literal pathspecs. It never performs a global clean. If a
  dirty ignore rule made preserved data visible after reset, discard reports `clean: false` and the
  remaining path summary instead of deleting the data or claiming the workspace is clean.

Any branch, HEAD, index, content, deletion, symlink target, or executable-bit change after the
preview makes the confirmation stale and aborts before recovery or discard is applied.

Pi itself does not provide a sandbox. The container boundary is therefore required; do not run the
worker directly on a host containing secrets or unrelated workspaces.

The egress proxy is a destination boundary, not a confidentiality filter: it does not decrypt TLS,
use a domain allowlist, or stop a permitted public model/package endpoint from receiving staged
source. A package manager that ignores proxy environment variables simply has no direct route and
fails. Treat every public endpoint and downloaded dependency used by a job as untrusted.

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
CODING_JOB_ROOT=./data/coding-job \
HTTP_PROXY=http://127.0.0.1:3128 \
HTTPS_PROXY=http://127.0.0.1:3128 \
pnpm dev:coding-worker
```

This host-mode command does not reproduce the container network boundary. Use the Compose profile
for security testing; set `CODING_REQUIRE_PROXY=1` in host mode when fail-closed proxy startup is
required.

The first version targets Node-based repositories because the worker image includes Node, pnpm,
Git, Bash, and ripgrep. Other build toolchains can be added to the worker image without expanding
the main bot image or giving Pi more GitHub authority.

## Resource footprint

The worker image is roughly 500 MB in the current build. The main application image excludes Pi's
runtime dependency graph, so this disk cost applies only when the optional worker is built. The idle HTTP shell does not import Pi;
loading the SDK added about 128 MB RSS in a local measurement. Active coding usually needs
300–800 MB, while a repository build can approach the configured 1 GiB container limit. Compose
also limits the worker to 1.5 CPU cores.

Canonical repositories keep ignored `.cos-pi-cache/` directories, which are preserved when the
server resets a completed commit into the canonical worktree. Ignored files are absent from the
worker's single-use staging slot because staging comes from the tracked index, not the raw
worktree. Canonical clones live only in the app's `codeworkspaces`
volume; the worker cannot mount or enumerate that volume. Inspect usage with `docker system df -v`
and prune individual stale workspaces during maintenance.

The hard staging quota uses the Docker local volume driver's Linux `tmpfs` mount options
(`size`, `uid`, `gid`, and `mode`). This is supported by Linux Docker Engine and Docker Desktop's
Linux VM. Deployment intentionally fails while mounting the volume on a runtime that cannot honor
those options; do not replace it with an unbounded named volume. Verify the rendered policy before
deployment with `docker compose --profile coding config`, and inspect the live bound with
`docker compose --profile coding exec app df -h /coding-job`.
