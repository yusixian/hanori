# AGENTS.md

See [CLAUDE.md](CLAUDE.md) for full project guidance (commands, architecture, conventions).

## CI / Self-hosted Runner

CI runs on the maintainer's Mac as a **self-hosted runner** (label `cos-tool-bot`), not on GitHub-hosted runners. If the runner is offline, CI jobs queue indefinitely and never execute.

Before pushing or opening a PR that should trigger CI, make sure the runner service is running:

```bash
cd ~/actions-runner/cos-tool-bot
./svc.sh status   # check status
./svc.sh start    # start the runner
```

One machine can host runners for multiple projects — each instance lives in its own directory (e.g. `~/actions-runner/voice-input`, `~/actions-runner/cos-tool-bot`) with its own launchd service.

See [readme.md](readme.md) for details (logs, re-registration, troubleshooting).
