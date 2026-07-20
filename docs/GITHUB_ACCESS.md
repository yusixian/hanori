# GitHub access

The bot can use a dedicated GitHub identity without exposing its credential to the language model.

## Permission boundary

- Non-administrators receive read tools only. Those tools use anonymous GitHub API requests, even
  when a token is configured, so they can only access public repositories.
- Administrators may use the configured token only for repositories in the explicit allowlist.
- Creating, updating, reopening, or closing an Issue creates a one-time Telegram confirmation. The
  exact request is bound to the initiating administrator and chat, expires after ten minutes, and is
  consumed before execution.
- Creating a pull request also requires a one-time confirmation. The preview resolves both branches
  in the allowlisted repository and binds the action to the exact remote head commit. Execution
  rejects a changed head, returns an existing same-repository open pull request idempotently, or
  creates and verifies a new one. Fork pull requests are not supported.
- The token is encrypted at rest, omitted from panel responses and data exports, and never included
  in a model tool result.
- GitHub MCP servers are marked administrator-only so they cannot bypass this boundary.

## Dedicated account setup

1. Create a separate GitHub account for Ai-chan and add it only to repositories it should access.
2. Create a fine-grained personal access token restricted to those repositories.
3. Grant `Metadata: Read`, `Contents: Read and write`, `Issues: Read and write`, and
   `Pull requests: Read and write`.
4. In the bot's AI Settings, enable GitHub tools, enter the account login, commit author name/email,
   token, and the `owner/repository` allowlist.

To let administrators create local branches and commits with Pi, start the optional worker described
in [PI_CODING_AGENT.md](PI_CODING_AGENT.md) and enable the Pi coding-agent switch. Push remains a
separate confirmed action.

Pull-request creation runs only in the trusted bot process and does not depend on the Pi worker. It
is a separate confirmed action after a branch has been pushed. GitHub does not provide an atomic
"verify head, check duplicates, and create" operation; if a POST response is lost, check the
repository before retrying. The bot rechecks for an open matching pull request to make retries
idempotent where GitHub exposes the result.

Leaving the token field empty on later saves preserves the existing encrypted token. Removing a
repository from the allowlist immediately removes credentialed access after the bot restarts.
