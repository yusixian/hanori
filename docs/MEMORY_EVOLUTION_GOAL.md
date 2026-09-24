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
  it was fixed. Changed-content edits refresh the vector with a content guard.
- Four child PRs were reviewed and merged into integration PR #100:
  #101 Agent lifecycle and panel controls, #102 bounded summary compaction and
  manual summary edit/cleanup, #103 autonomous shared memory consolidation,
  and #104 guarded exact-duplicate cleanup for historical memories. The Lody
  summary and consolidation sessions completed and their code was integrated.
- Historical memory rows remain readable. Nullable provenance and scope fields
  do not silently reassign old rows; isolated mode excludes unknown-source
  unscoped personal entries. Legacy exact-duplicate cleanup is opt-in and
  limited to 50 records per confirmed batch. It compares validity metadata,
  retains vector search when one copy has an embedding, and uses row locks and
  version checks. A disposable PostgreSQL test caught and verified a fix for
  inconsistent timestamp parsing between the preview and mutation paths.
- Old cumulative summaries remain readable. New compaction bounds retained
  versions; admins can edit the active summary by creating a guarded version
  and preview/clean old snapshots in batches. Raw message history is kept
  separate from summary retention.
- Final cross-module review found a microsecond-versus-millisecond version
  mismatch on memory edits. The guarded update now compares at API precision,
  advances the version monotonically, and keeps embedding-only writes from
  changing it. A second review caught a session-timezone conversion; the
  update now uses UTC. Both fixes passed a disposable PostgreSQL test under an
  Asia/Shanghai database timezone, including stale and concurrent writes.
  PR #100 merged as `168547e625c7bacc18448359dab22b7d8997e7fc`; main CI passed.
- Follow-up draft PR #105 provides the transaction-compatible memory store and
  owner/admin-only historical batch preview. Final review found a preview
  discrepancy around raw batch boundaries and opt-out participants; the fix
  passed focused tests and final code review. CI for the prior PR head failed
  during browser checks after the self-hosted runner lost contact.
- A `v0.15.0` release-note candidate covers the merged memory changes and the
  follow-up API. No tag, GitHub Release, migration against production, or
  deployment has been performed as part of this goal.
- Current summaries are cumulative snapshots. Forced group compression can
  bypass the usual message threshold. Existing `/privacy forget` contract
  excludes selective deletion of shared group summaries; do not clear an
  entire group's history as an implicit consequence of one user's request.
