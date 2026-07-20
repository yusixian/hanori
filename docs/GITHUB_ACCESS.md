# GitHub access

The bot can use a dedicated GitHub identity without exposing its credential to the language model.

## Permission boundary

- Non-administrators receive read tools only. Those tools use anonymous GitHub API requests, even
  when a token is configured, so they can only access public repositories.
- Administrators may use the configured token only for repositories in the explicit allowlist.
- Creating, updating, reopening, or closing an Issue creates a one-time Telegram confirmation. The
  exact request is bound to the initiating administrator and chat, expires after ten minutes, and is
  consumed before execution.
- The token is encrypted at rest, omitted from panel responses and data exports, and never included
  in a model tool result.
- GitHub MCP servers are marked administrator-only so they cannot bypass this boundary.

## Dedicated account setup

1. Create a separate GitHub account for Ai-chan and add it only to repositories it should access.
2. Create a fine-grained personal access token restricted to those repositories.
3. Grant `Metadata: Read`, `Contents: Read and write`, and `Issues: Read and write`. Add
   `Pull requests: Read and write` only when PR creation is enabled.
4. In the bot's AI Settings, enable GitHub tools, enter the account login, commit author name/email,
   token, and the `owner/repository` allowlist.

Leaving the token field empty on later saves preserves the existing encrypted token. Removing a
repository from the allowlist immediately removes credentialed access after the bot restarts.
