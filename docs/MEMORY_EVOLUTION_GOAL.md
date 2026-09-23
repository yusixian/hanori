# Memory and conversation continuity goal

## Requested outcome

Improve the Bot's long-term memory in one delivery: give the Agent a complete
add/update/retire/forget lifecycle, retain useful shared experiences and unfinished
threads, add bounded autonomous consolidation, and improve conversation-history
compaction and manual summary management. Existing memories, message history, and
summaries must remain readable through the change and have a safe cleanup path.

## Delivery boundary

- The user authorized implementation, focused lint/tests/review, and a stacked PR
  workflow: one integration PR with smaller PRs targeting it, then final review
  before integration. Do not run the large acceptance harness for this work.
- No production data changes, deployment, real Telegram messages, or release were
  requested. Cleanup code must be reviewable and must not run against production
  as part of development.
- Preserve unrelated untracked files in the root worktree. Start from
  `origin/main` at `8bbdcae127ecf66bfb1c5bf4f10891066e45fc93`.

## Current evidence

- The Agent already has `save_memory`, `recall_memories`, and `delete_memory`, but
  no update tool. The panel has memory edit/delete routes. `bot_memories` already
  contains `is_active`, `superseded_by_id`, and `fact_valid_at`; the save path
  only touches very close embedding matches and otherwise inserts.
- Compression writes a new cumulative `conversation_summaries` row and changes
  the active pointer. Old rows remain until retention cleanup. A forced
  compression path may run after only a few new messages; investigate and test
  that path before changing its thresholds.
- The provided screenshot shows 1,160 compressed summaries for a chat with
  4,479 messages and near-duplicate consecutive summaries. This is user
  evidence of the UI/data symptom, not proof of the exact trigger frequency.

## Work slices

1. Foundation: contracts and migration for provenance, validity, and lifecycle;
   preserve legacy rows with defaults and nullable metadata.
2. Agent memory operations: update, retire, hard forget, conflict resolution,
   embeddings, scope and privacy, with focused behavioral tests.
3. Companion continuity: shared events and open threads, selected retrieval,
   bounded autonomous consolidation and opt-out/expiry semantics.
4. Conversation compaction: reduce redundant versions, allow guarded editing
   of the active summary, expose safe cleanup for old versions, and preserve
   historical cursor/raw-history invariants.
5. Panel and public guides, focused checks, independent review of slices,
   stacked PR integration, final review and CI before merge.

## Open decisions and progress

- 2026-09-24: Created `feat/memory-evolution` from current `origin/main`.
- Foundation now adds nullable lifecycle, source, scope, and expiry metadata in
  migration 0052. Legacy rows retain their old scope. Store reads exclude
  expired/other-chat entries; updates and retirement are guarded. Unchanged
  content preserves its embedding; changed content clears the stale vector.
  Focused store/selector tests, server typecheck, scoped lint and format pass.
- Independent foundation review found the unchanged-content embedding issue;
  it has been fixed. Changed-content embedding regeneration/backfill remains
  an integration requirement.
- A separate Lody worktree/session (`fd50339c-8af4-4421-90dc-3898edb53d71`)
  owns summary compaction, edit, and retention implementation on
  `feat/memory-summary`; it has not yet handed off code.
- Current summaries are cumulative snapshots. Forced group compression can
  bypass the usual message threshold. Existing `/privacy forget` contract
  excludes selective deletion of shared group summaries; do not clear an
  entire group's history as an implicit consequence of one user's request.
