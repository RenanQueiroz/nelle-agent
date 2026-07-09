# Nelle Gap Remediation Plan

Last updated: 2026-07-09

## Purpose

`plans/nelle-agent-architecture.md` and `plans/nelle-router-chat-ui-plan.md`
describe the intended product. This file lists the places where the
implementation and those plans disagree, and how to close each one.

Everything here falls into one of four buckets:

- behavior a plan marks `Done` that is not actually done,
- behavior no plan mentions that is nonetheless wrong,
- dead code or dead schema that will mislead the next reader,
- documentation that contradicts the implementation.

## Out Of Scope

Work that is simply not started yet is tracked in the other two plans and is
within expectations. It is **not** part of this plan:

- Milestone 5: mobile LAN pairing, QR pairing, device credentials, Expo push.
- Milestone 6: packaging, installers, launcher binaries.
- Progress streaming for long llama.cpp installs/builds.
- Host-tool sandboxing and per-tool permission prompts.
- The full Pi branch tree explorer.
- Full SQLite app-state migration and the all-artifact backup runner.
- The seven-screen first-run setup wizard.

The last item is currently missing from README's "Not implemented yet" list; see
G11.

## How This Was Verified

Audited against commit `c1476e3` with a clean working tree. `npm test` (77 unit
tests) and `npm run test:e2e` (32 e2e tests) both pass at that commit. Every
`file:line` reference below was read, not inferred.

## Severity And Order

| ID  | Gap                                         | User impact | Effort |
| --- | ------------------------------------------- | ----------- | ------ |
| G1  | Conversation list capped at 50; dead search | High        | Large  |
| G2  | `unavailable` conversations unrecoverable   | High        | Medium |
| G5  | Stream event contract half-migrated         | Low today   | Medium |
| G3a | `model_cache` table never used              | Low         | Medium |
| G4  | Snapshot `capabilities` unused and wrong    | Low today   | Small  |
| G6  | Missing stable `NelleError` codes           | Medium      | Medium |
| G7  | No `tools_disabled` fail-closed guard       | Medium      | Small  |
| G3b | `conversations.deleted_at` is dead schema   | None        | Small  |
| G8  | Legacy default-chat surface still live      | None        | Medium |
| G9  | Fallback context size is 8192               | None        | Tiny   |
| G10 | Test coverage gaps                          | —           | Medium |
| G11 | Documentation drift                         | —           | Small  |

"User impact: Low today" means the defect is currently masked by the browser
being the only client. It stops being masked the moment `nelle-client` exists.

---

## G1: The Conversation List Is Capped At 50, And Search Is Dead

**Status: done.**

### Symptom

The sidebar can never display more than the 50 most recently updated
conversations. Searching for anything older silently returns nothing.

### Evidence

- `apps/web/src/api.ts:673` — `getConversations()` sends no query parameters.
- `apps/server/src/conversations.ts:225` — `Math.min(Math.max(input.limit ?? 50, 1), 200)`.
- `apps/server/src/server.ts:89` — `listConversationsQuerySchema` accepts
  `search` and `limit`, but no `cursor`.
- `apps/web/src/components/sidebar/NelleSideNav.tsx:483` — the sidebar filters
  client-side over whatever it already fetched.
- `apps/server/src/conversations.ts:1160` — `searchConversations()` implements
  FTS5 with a `LIKE` fallback, and is unreachable from the UI.
- `tests/e2e/workbench.spec.ts:2216` — the virtualization test feeds 180
  conversations through a **mocked** route, so it never exercises the real cap.

### Why It Matters

The router plan's API shape specifies `GET /api/conversations?search=&cursor=&limit=`,
and Phase 3's exit criteria claim large lists are handled by the virtualized
sidebar. The virtualizer is real and correct; the data feeding it is capped, so
the feature cannot pay off. Meanwhile a working server-side FTS index sits
unused, and the client-side filter gives a false negative for any conversation
past the cap — the worst kind of search bug, because it looks like an answer.

### Fix

**Server** (`apps/server/src/conversations.ts`, `apps/server/src/server.ts`):

Split pinned rows from recent rows, because the sidebar already renders them as
separate sections and because keyset pagination across a `pinned DESC` boundary
is needlessly awkward.

- `listPinnedConversations()` returns every pinned row ordered by
  `updated_at DESC, id DESC`. Pinned counts are small by construction; cap at
  200 and `log()` if the cap truncates.
- `listRecentConversations({cursor, limit})` uses keyset pagination over
  `(updated_at, id)`:

```sql
SELECT * FROM conversations
WHERE pinned = 0
  AND (updated_at, id) < (?, ?)
ORDER BY updated_at DESC, id DESC
LIMIT ?
```

SQLite has supported row-value comparison since 3.15; `node:sqlite` bundles
3.53.1, so this form is safe.

- The cursor is opaque to the client: base64url of `{updatedAt, id}`. Do not let
  callers pass an offset — offsets skip rows when a conversation is updated
  mid-scroll.
- `searchConversations(query, {limit, cursor})` keeps FTS5-first with the `LIKE`
  fallback, but orders by `updated_at DESC, id DESC` after the `MATCH` so the
  same cursor shape works. **Do not paginate by FTS rank** — rank ordering is
  unstable across inserts, so page 2 would overlap page 1.
- `GET /api/conversations` gains `cursor`, and returns
  `{conversations, nextCursor?}`. Pinned rows are included in the first page
  only (when `cursor` is absent), so the pinned section is always complete.
  Keep `conversations` as the response key so existing e2e mocks keep parsing.

**Migration 5** adds the covering index. Keep the existing two indexes.

```sql
CREATE INDEX IF NOT EXISTS conversations_recent_keyset_idx
  ON conversations(pinned, updated_at DESC, id DESC);
```

**Web**:

- `apps/web/src/api.ts` — `getConversations(input?: {search?, cursor?, limit?})`
  returns `{conversations, nextCursor}`.
- Add a conversations slice (extend `uiStore`, or a new `conversationsStore`)
  holding `conversations`, `nextCursor`, `isLoadingMore`, `search`. Per AGENTS.md,
  use narrow selectors so the transcript does not rerender on list changes.
- `NelleSideNav.tsx`:
  - delete the client-side `.filter()` at `:483`; keep the pinned/recent
    grouping and the flattened row model,
  - debounce the search input by ~200ms and refetch page 1 with `?search=`,
  - watch the virtualizer range; when the last rendered index reaches
    `rows.length - 1 - overscan` and `nextCursor != null && !isLoadingMore`,
    fetch the next page and append,
  - keep `getItemKey` stable (`conversation:<id>`, `section:<name>`).
- Invalidation: after create, delete, pin, unpin, rename, import, fork, or
  clone, reset to page 1. This is what `refreshConversations()` effectively does
  today. Scroll position resets; accept that for now.

### Edge Cases

- A conversation whose `updated_at` changes mid-scroll can appear on two pages.
  Dedupe by `id` when appending.
- SQLite builds without FTS5 fall through to `LIKE` (`database.ts:332` creates
  the FTS table in a `try/catch` on purpose). Pagination still works because the
  ordering key is `(updated_at, id)` either way.
- Empty search results keep the existing Astryx `EmptyState`.

### Tests

- Unit: keyset pages over a 120-row fixture are disjoint, ordered, and cover
  every row; `search=` finds a row that lives on page 3; the `LIKE` fallback is
  exercised by dropping the FTS table first.
- E2e: rewrite `virtualizes and collapses the conversation sidebar` so the mock
  serves real paginated responses. Add `finds a conversation that is not on the
first page` — type into search, assert the row appears. That test must fail
  against today's client-side filter.

### Docs

Router plan: Phase 3 exit criteria and the API shape section. README's feature
list.

---

## G2: `unavailable` Conversations Are A Dead End

**Status: done.**

### Symptom

When a Pi session file goes missing or corrupt, the conversation is marked
`unavailable` and there is no way back. No repair, no diagnostics, and because
`canFork` is false, no way to salvage the history either. The only exits are
delete and import.

### Evidence

- `packages/shared/src/conversations.ts:134` — the state machine allows
  `unavailable -> ready`.
- Nothing triggers that transition. `setConversationReadyUnlessUnavailable`
  (`apps/server/src/piHarness.ts:1075`) explicitly refuses to revive one.
- `apps/server/src/conversations.ts:265` `markInvalidPiSessionsUnavailable()`,
  `:284` `markUnavailableIfPiSessionInvalid()` set the status.
- `apps/server/src/conversations.ts:613` — snapshot returns `canFork: false`.
- `apps/web/src/components/sidebar/NelleSideNav.tsx:454` — the UI's entire
  response is a red status dot.
- No `repair` identifier exists anywhere in the repo.

### Why It Matters

The router plan explicitly promises `unavailable -> ready` "only after explicit
repair/reimport succeeds", and the current session-validation design is built
around never silently replacing a session file. Both halves are right. The
missing half is the explicit repair the design assumes exists.

### Fix

Two new endpoints:

```http
POST /api/conversations/:id/repair
GET  /api/conversations/:id/diagnostics
```

`repair` behavior:

1. Re-run `piSessionFileError(row.pi_session_path)`. If the file is now valid —
   the user restored it from a backup — reopen it with `SessionManager.open()`,
   resync the projection from `SessionManager.getBranch()`, transition to
   `ready` through the existing state machine, and return the snapshot.
2. If the file is still invalid, return 409 with
   `{code: 'session_unavailable', message, detail: '<expected path>'}`. **Never**
   create a replacement session under the same conversation id — that is a
   standing AGENTS.md rule and the reason this status exists at all.

`diagnostics` returns enough for the user to act:
`{conversationId, piSessionPath, exists, reason, sizeBytes, projectionEntryCount,
attachmentCount, toolAuditCount}`.

Additionally, let `POST /api/conversations/:id/export` succeed for an
unavailable conversation: omit `pi-session.jsonl`, set
`manifest.piSessionMissing = true`, and keep the sidecar metadata and
attachments so the user can salvage what SQLite still holds. Import must then
reject or visibly flag such an archive rather than silently producing an empty
conversation.

Snapshot: add `capabilities.canRepair = status === 'unavailable'` (see G4).

UI:

- Sidebar row menu for an unavailable conversation shows `Repair`,
  `Export diagnostics`, `Delete`. Hide pin/rename/duplicate/fork.
- The chat pane renders an Astryx `EmptyState` naming the missing path, with
  `Repair` as the primary action and `Delete` as secondary. The composer stays
  disabled with a top status error.
- After a successful repair, refresh the snapshot and the sidebar row.

### Rebuild From Projection (Decided)

`conversation_entry_projection.text_preview` is misnamed: `upsertProjection`
writes the **full**, untruncated `entry.text` into it
(`apps/server/src/conversations.ts:1089`), alongside `reasoning_text`,
`tool_calls_json`, `performance_json`, roles, parentage, and timestamps. So
SQLite holds a complete copy of the active path. `migrateLegacyDefaultConversation`
(`apps/server/src/piHarness.ts:155`) already demonstrates the reconstruction
technique: walk messages, call `sessionManager.appendMessage({role, content})`
per message, then `replaceConversationProjection`.

Add a third, explicitly user-initiated endpoint:

```http
POST /api/conversations/:id/rebuild
```

It reconstructs a valid Pi session JSONL from the projection rows. This is not
the "silently create a replacement session" that AGENTS.md forbids: it is a
reconstruction from data Nelle already holds, reachable only from an explicit
user action with a warning dialog, never from a read path.

What it recovers: message text, roles, ordering, timestamps, per-message
reasoning, model alias snapshots, and performance metadata.

What it loses, and the dialog must say so:

- **Tool-call results.** Tool calls live in `tool_calls_json` on the assistant
  projection row, not in Pi message content, so the rebuilt entries carry no
  tool output and the model loses that context on subsequent turns.
- **Image attachment content.** Rebuilt user entries are text-only. The
  attachment metadata rows and the content-addressed files survive, so the UI
  keeps rendering the chips, but the model will not see the images again.
  Re-embedding them from `.nelle/attachments/` is a possible follow-up.
- **Compaction summaries.** Projections can hold `entryType: 'compaction'` rows
  and `appendMessage` cannot produce them. Rebuild skips them, so the session
  keeps the messages that survived compaction without the summary explaining the
  gap. This is a deliberate choice, not an oversight.
- **Regenerate variants.** A rebuilt Pi session is linear, so a variant has
  nowhere to hang. `getActivePathEntries()` walks the active branch only, and
  `replaceConversationProjection` deletes the rows it is not handed, so variants
  leave both the session file and the projection. The rebuild also remaps every
  `pi_entry_id` in `message_attachments`, because Pi hands out fresh ids and the
  attachments would otherwise stay bound to entries that no longer exist.

A blank `rebind` (fresh empty session under the same conversation id) is
explicitly **rejected**. It preserves only the title and pin state versus
delete-then-create, orphans the attachment and tool-audit rows, and is the one
variant that breaks the replacement-session invariant for no recovery gain.

### Tests

- Unit: repair after restoring the file flips status to `ready` and rebuilds the
  entries; repair with the file still missing returns `session_unavailable` and
  creates **no** new file under `.nelle/pi/sessions` (assert the directory
  listing is unchanged before and after).
- Unit: rebuild reconstructs a readable Pi session from projection rows, sets the
  conversation `ready`, preserves message text/roles/order and `reasoning_text`,
  and skips `compaction` entries.
- E2e: an unavailable conversation shows the repair `EmptyState` and its row
  menu offers Repair; rebuild is behind a confirm dialog naming what is lost.

---

## G3: Dead Persistence

Three independent findings that share a root cause: schema written ahead of its
readers.

### G3a: `model_cache` Is Never Read Or Written

**Status: done.**

`apps/server/src/database.ts:102` creates the table with exactly the columns the
plan asks for. The only occurrence of `model_cache` in the entire repo is that
`CREATE TABLE`. Model props live only in browser memory, keyed by
`(modelId, routerStatus)` (`apps/web/src/App.tsx:170-180`).

**Fix: populate it**, because G4 and G6 both need a server-side answer to "what
can this model do?" without a live router.

Writers:

- `GET /api/llama/models` (`server.ts:225`) upserts
  `{section_id, hf_repo, alias, router_model_id, status, updated_at}` per row.
- `GET /api/llama/models/:id/props` (`server.ts:276`) upserts
  `{modalities_json, context_window}` on success.
- `writePresetAndReloadRouter` deletes rows whose `models.ini` section no longer
  exists.

Readers:

- snapshot `capabilities.canAttachImages` (G4),
- server-side attachment validation (G6),
- a fallback source for assistant `model_runtime_id` when the stream does not
  report one.

Rules: this is a cache, never a source of truth. The router is authoritative
whenever it is up. When llama-server is stopped, leave rows as-is and let
`updated_at` express staleness — do not clear them.

### G3b: `conversations.deleted_at` Is Dead

**Status: done.** The undo toast is the next commit.

The column (`database.ts:47`) is filtered on in five queries
(`conversations.ts:233, 244, 269, 1168, 1182`) and only ever written as `NULL`
(`:202, :963, :972`). Delete is a hard delete (`hardDeleteConversation` `:848`,
`hardDeleteAllConversations` `:916`), which is the settled decision.

A `WHERE deleted_at IS NULL` that is always true reads as a soft-delete
guarantee that does not exist.

**Fix: drop it.** Verified safe: `deleted_at` participates in no index, and the
bundled SQLite (3.53.1 via `node:sqlite`) supports `ALTER TABLE ... DROP COLUMN`.

Migration:

```sql
ALTER TABLE conversations DROP COLUMN deleted_at;
```

with `isApplied: db => !tableHasColumn(db, 'conversations', 'deleted_at')`, then
remove the filters and the `NULL` writes.

The alternative — actually implementing soft delete — contradicts "Conversation
delete is a hard delete for now" and would strand Pi session files and
attachments until a purge job exists. Rejected.

### Decided: Drop It, Then Add A Client-Side Undo Window

**Status: done.**

Ship as **two commits**. The migration is a cleanup; the undo toast is the only
item in this whole plan that adds product behavior rather than closing a gap, and
it should not ride along with a schema change.

The toast: deleting a conversation removes the row from the sidebar immediately
and shows `Deleted "<title>". [Undo]`, holding the `DELETE` request for ~5s.
Constraints, all of which come from hard delete being irreversible once it lands:

- Flush the pending `DELETE` on `beforeunload` with `navigator.sendBeacon`.
  Without this a page reload inside the window silently _cancels_ the deletion
  and the conversation returns from the dead — the same shape as the
  `legacy-default` resurrection AGENTS.md warns about. Committing on unload makes
  the window a real time bound rather than a session-lifetime one.
- Queue timers per conversation id. Deleting three chats in a row must issue
  three deletes, not one.
- If the deleted conversation was active, switch away immediately; undo restores
  both the row and the selection.
- Once the request lands, the Pi session file and unreferenced attachments are
  gone. The toast is the entire safety net, and it does not survive the window.
  Say so in the toast copy.

### G3c: Fork Lineage Columns Are Write-Only

`parent_conversation_id`, `forked_from_pi_entry_id`, and `fork_kind` are written
on create/fork and surfaced in snapshots, but never queried or joined.

**Fix: none.** These are legitimately forward-looking for the branch explorer.
Add a sentence to the router plan saying so, and add no index until a reader
exists.

---

## G4: The Snapshot `capabilities` Block Is Unused, And One Field Lies

**Status: done**, with one refinement discovered while building it. `canAbort` and
`canCompact` describe a run that may have started _after_ the snapshot was taken,
so a client with live run state — the browser — must prefer its own. The browser
consumes `canRepair`, which is durable: it stays true until a repair or rebuild
succeeds. The rest of the block is documented as the point-in-time contract for
clients without live run state.

### Evidence

- `apps/server/src/conversations.ts:614` — `canAttachImages: false`, hardcoded.
- `apps/web/src/api.ts:320-326` types the block; grep finds **zero** readers in
  `apps/web/src`. The browser derives image gating from live model props.

### Why It Matters

Nothing breaks today because the only client ignores the field. The router plan's
whole premise is that `nelle-client` consumes this same REST snapshot, at which
point a hardcoded `false` silently disables image attachments on a vision model.

### Fix

- `canAttachImages`: derive from `model_cache.modalities_json` (G3a) for the
  conversation's selected/default model. Make it tri-state `boolean | null`,
  mirroring the `canReason` precedent already established in the composer:
  `null` means "the model has never been loaded, so llama.cpp has not reported
  modalities". Only return `false` when modalities are known and vision is
  absent.
- Add `canRepair` (G2).
- Drop `canAttachText`. It is unconditionally `true`.

### Decided: The Conversation/Runtime Split

The objection to letting the browser consume `capabilities` is staleness: it
ships in a snapshot, while router status changes live over SSE. That dissolves
with the right division of labour.

Server capabilities describe what the **conversation** permits — durable facts
only: is the status `ready`, is the Pi session valid, are there entries to fork
from. The client ANDs in what the **runtime** currently permits:

```text
browser canSend = capabilities.canSend && routerUp && modelSelected
```

Under that split `canAbort`, `canCompact`, `canFork`, and `canRepair` are purely
conversation-level, and the browser uses them directly. `canSend` becomes
`status === 'ready' && sessionValid` server-side — it drops the
`state.runtime != null` check, which is runtime state the client owns.

`canAttachImages` is inherently live, so it stays a last-known tri-state derived
from `model_cache` for clients without router access, while the browser keeps
using fresh `/api/llama/models/:id/props`. Add a unit test asserting the two
agree for a loaded model, and document in `packages/shared/src/conversations.ts`
that the cached value is best-effort.

---

## G5: The Stream Event Contract Is Half-Migrated

**Status: done.** `conversation.forked` was dropped rather than shipped as a union
member nobody emits — fork and clone are plain JSON routes, and Nelle has no
conversation-level SSE channel. It belongs with that channel.

### Evidence

Dotted envelope names already shipped: `run.started`, `run.aborted`,
`run.completed`, `context.updated`, `compact.started`, `compact.completed`,
`compact.failed`, `message.assistant.completed`.

Still snake_case on the wire (`apps/server/src/types.ts:178-243`):
`user_message`, `assistant_start`, `assistant_delta`, `assistant_reasoning`,
`assistant_metrics`, `tool`, `conversation_title`, `warning`, `done`.

`conversation.forked` is specified by the plan and never emitted.

### Why It Matters

`apps/server/src/server.ts:929-934` mirrors each inner event's `type` onto the
envelope, so the union member names _are_ the wire format. Right now there is
exactly one client. That is the cheapest moment this rename will ever have.

### Fix

Rename in one atomic pass:

```text
user_message         -> message.user.created
assistant_start      -> message.assistant.started
assistant_delta      -> message.assistant.delta
assistant_reasoning  -> message.assistant.reasoning_delta
assistant_metrics    -> performance.updated
tool                 -> tool_call.updated
conversation_title   -> conversation.updated
warning              -> run.warning
done                 -> (delete)
```

**Decided: `reasoning_delta`, not the router plan's `thinking_delta`.** Nelle's
whole public surface says _reasoning_ — `conversations.reasoning_level`,
`conversation_entry_projection.reasoning_text`, `ReasoningLevel`,
`PATCH /api/settings/reasoning`, `PUT /api/conversations/:id/reasoning`, and the
`message.reasoning` field. Only Pi's internals say _thinking_
(`thinking_delta`, `setThinkingLevel`), and llama.cpp says `reasoning_content`.
`piHarness` is where those vocabularies meet; the wire contract should stay on
Nelle's side of that boundary. Update the router plan's proposed name and the
AGENTS.md line that pins `assistant_reasoning`.

- `conversation.updated` should carry `{title?, titleSource?, activeLeafPiEntryId?, updatedAt}`
  rather than only `title`, per the router plan.
- Emit `conversation.forked` from `POST /api/conversations/:id/fork` and
  `/clone` (`server.ts:712, 734`).
- Delete `done` (`piHarness.ts:851`, `directLlama.ts:149`) and drop the
  `|| event.type === 'done'` branch at `apps/web/src/App.tsx:1661`.
  `message.assistant.completed` already carries the same payload.
- Keep `normalizeStreamEvent` (`apps/web/src/api.ts:905`) unwrapping `data`.
  That fallback is about envelope-versus-raw payloads, not names, and the e2e
  mocks depend on it.

**No dual-emit window.** The only consumers are the bundled web app and the
tests; the mobile client does not exist. Dual-emitting would double every stream
event for a compatibility window with no clients in it.

Files to touch: `apps/server/src/types.ts`, emitters in `piHarness.ts` and
`directLlama.ts`, the mirrored union in `apps/web/src/api.ts:210-230`, the
handlers in `apps/web/src/App.tsx:1512-1675`, the e2e mocks in
`tests/e2e/workbench.spec.ts`, and `tests/unit/conversations.test.ts`.

### Decided: `run.warning` Carries A Code

`warning` is not one event, it is five conditions sharing a prose field. AGENTS.md
forbids message-only `error` events; warnings simply escaped the rule. A browser
can render prose, but no other client can branch on it, localize it, or suppress
a known-benign one.

Give `run.warning` the shape `{code, message, detail?}` — the `NelleError` family
minus `retryable` — and assign each existing emitter a stable code:

| Emitter             | Code                          | Condition                                         |
| ------------------- | ----------------------------- | ------------------------------------------------- |
| `directLlama.ts:57` | `pi_harness_fallback`         | Pi failed; falling back to direct llama.cpp       |
| `piHarness.ts:662`  | `reply_budget_exhausted`      | Prompt leaves no room for a reply                 |
| `piHarness.ts:811`  | `reasoning_budget_exhausted`  | Whole reasoning budget spent, no answer produced  |
| `piHarness.ts:818`  | `reasoning_without_answer`    | Reasoning content but no final text; showing it   |
| `piHarness.ts:1636` | `llama_slot_still_processing` | Slot still busy after the post-abort grace window |

The last code already exists on the REST abort response (`llamacpp.ts:247`), so
the stream and the REST path finally agree on one name.

---

## G6: Most Of The Specified `NelleError` Codes Do Not Exist

**Status: done.**

### Evidence

`apps/server/src/errors.ts:42-64` maps exactly three: `conversation_busy`,
`invalid_conversation_transition`, `session_unavailable`. Emitters pass ad-hoc
fallback codes elsewhere (`llama_direct_failed`, `compact_failed`,
`pi_run_failed`, `title_generation_failed`, `llama_slot_still_processing`,
`host_tools_acknowledgement_required`, `model_not_found`, `invalid_archive`,
`invalid_archive_upload`, `conversation_not_found`, `stream_failed`,
`internal_error`).

Of the eight codes the router plan names, five have **no implementation at all**
— not a missing mapping, missing behavior.

### Fix

First, export a single `NELLE_ERROR_CODES` const from
`packages/shared/src/contracts.ts` and derive the union type from it, so server
and browser share one discoverable set. Fold the ad-hoc codes above into it.

Then implement the five missing behaviors:

1. **`context_overflow`** — llama.cpp reports `n_prompt_tokens` and `n_ctx` when
   a prompt exceeds the window. Nelle detects this nowhere today (grep for
   `n_prompt_tokens` finds only `llamaThroughput.ts`, which reads slot stats).
   `llamaProxy.ts` must inspect non-2xx upstream bodies **and** in-stream `error`
   chunks, and map them. The composer already routes blocking errors to the top
   status (`ChatComposerPanel.tsx:291`).
2. **`model_load_failed`** — map router `/models/load` failures and the
   load-before-send/regenerate helper.
3. **`llama_server_stopped`** — add the server-side guard on chat, regenerate,
   and compact when the runtime is not running. Today only the browser blocks.
4. **`unsupported_attachment`** — validate `chatRequestSchema` attachments
   server-side against the selected model's cached modalities. Depends on G3a
   and G4. Today image gating is browser-only, so any non-browser client can
   post an image to a text-only model.
5. **`unsupported_slash_command`** — add the allowlist check to the chat route.
   `/compact` is intercepted in the browser; a raw `/model` from any other client
   reaches Pi as a literal prompt, which is exactly what the plan forbids.

---

## G7: Host Tools Have No Fail-Closed Guard

**Status: done.**

### Evidence

`apps/server/src/piHarness.ts:1040` builds the Pi registry as
`tools: toolsEnabled ? TOOL_ALLOWLIST : []`. That is a construction-time gate
only. The tool event subscriber (`:726`) records an audit row and streams the
call without rechecking. `tools_disabled` appears nowhere in the repo.

The router plan anticipated this: "A future stricter guard can add explicit
`tools_disabled` stream errors if Pi ever emits a tool event despite an empty
registry."

### Fix

At the top of the tool event subscriber, recheck
`this.hostTools.areToolsEnabled()`. When disabled: skip `recordToolStart`, do
not push the `tool_call.updated` event, push
`createErrorEvent(new Error('tools_disabled'))`, and abort the run. Map
`tools_disabled` in `errors.ts` with `retryable: false`.

This also settles what happens when the user disables host tools mid-stream.
Today the setting change resets cached Pi sessions but leaves the running one
alone. With the guard, the next tool call in that run fails closed. Document
that as the intended behavior rather than trying to kill the run.

### Tests

Unit: stub a Pi tool event while tools are disabled. Assert the stream ends with
`tools_disabled`, **no** `tool_audit_events` row was inserted, and the
conversation returns to `ready`.

---

## G8: The Legacy Default-Chat Surface Is Still Live

**Status: done, except one deliberate remainder.** `state.json.chat[]` is still
written by `directLlama`, because the direct fallback runs precisely when Pi is
unavailable and therefore has no session file to persist into. Removing that
write would not make the fallback conversation-scoped; it would make it
amnesiac. Pi's own duplicate mirroring into `state.chat` is gone, so the array no
longer grows during normal use.

Separately: an unknown `/api/...` path returns the SPA's `index.html` with a 200
rather than a 404, because the static plugin's history fallback catches it. Not
introduced here, and out of this plan's scope, but worth a route guard.

### Evidence

- Routes: `POST /api/chat/stream` (`server.ts:844`), `GET /api/chat/messages`
  (`:756`), `DELETE /api/chat/messages` (`:761`).
- `LEGACY_DEFAULT_CONVERSATION_ID` (`conversations.ts:28`) is threaded through
  `server.ts`, `piHarness.ts`, and `directLlama.ts:49, 153, 162`.
- `streamLegacyChat` (`apps/web/src/api.ts:919`) and `clearChat` (`:825`) are
  exported and called from nowhere.
- `syncLegacyDefaultConversationFromState` is called from nine read/write paths
  (`server.ts:126, 344, 362, 379, 392, 398, 765, 798, 864`).

Router plan Phase 3 asks to "replace legacy default-chat compatibility with
conversation-scoped APIs throughout the UI and server".

### Fix

Stage it, because `directLlama` still depends on the legacy id.

1. Delete the dead web exports `streamLegacyChat` and `clearChat`. No callers,
   zero risk.
2. Make `directLlama` conversation-scoped like the Pi path, so it stops
   hardcoding `LEGACY_DEFAULT_CONVERSATION_ID`.
3. Remove `syncLegacyDefaultConversationFromState` from the read paths, keeping
   only the startup call (`server.ts:126`) for the one-time migration. AGENTS.md
   already warns these calls can resurrect a deleted conversation; the guard
   against creating from an empty chat is the only thing preventing it, and the
   calls do filesystem work on every list request.
4. Delete `POST /api/chat/stream` and `GET`/`DELETE /api/chat/messages` after
   porting `tests/unit/conversations.test.ts:2194` to
   `/api/conversations/:id/chat/stream`.
5. Stop appending to `state.json.chat[]` (`store.ts:283-288`). It becomes
   read-only input for the startup migration.

`legacy-default` survives as an ordinary conversation id on existing installs.
Nothing special-cases it afterwards.

---

## G9: The No-Models Fallback Uses An 8192 Context

**Status: done.**

`apps/server/src/piHarness.ts:1325` — `getProjectionModel()` returns a synthetic
model with `params: {contextSize: 8192}` when `state.models` is empty. Import
`DEFAULT_CONTEXT_SIZE` from `apps/server/src/store.ts:32` (16384) instead.

Only reachable with zero configured models, so it cannot bite today. But 8192 is
precisely the window AGENTS.md documents as clamping `max_tokens` to 1 and
truncating every reply after one word. Leaving that number in the tree invites
someone to copy it.

---

## G10: Test Coverage Gaps

No coverage at all:

- attachment file classification, size/count limits, content-hash storage, and
  the PDF/text extraction fallback — unit tests against
  `apps/web/src/utils/attachments.ts` and the server persistence path. These
  decide what reaches disk; close this one first.
- removing an attachment from the composer drawer — e2e.
- unknown Pi event tolerance — unit. Feed an unrecognized Pi event through the
  subscriber, assert the stream continues and nothing renders. The plan requires
  this explicitly.
- a second concurrent **chat** run in one conversation returns
  `conversation_busy`. Only `/compact` is covered today.
- `tools_disabled` fail-closed (G7).
- `context_overflow` surfacing as a composer top error (G6).
- context progress bar warning (>=80%) and error (>=100%) thresholds.
- clipboard text formatting — unit. Today only the e2e click exists.
- `buildConversationRows` flattening, stable virtual keys, and pinned/recent
  grouping — unit.

Partial, worth strengthening:

- alias-snapshot fallback when the generating model was removed from
  `models.ini`,
- regenerate model-override validation,
- fork/clone source-entry eligibility (rejecting an unpersisted or non-user
  entry).

After G1, the virtualization e2e must serve **paginated** mock responses. Today
it hands the UI 180 conversations in a single response, which the real server can
never produce.

---

## G11: Documentation Drift

- `plans/nelle-router-chat-ui-plan.md:1360-1362` still says "Assistant
  reasoning/thinking deltas are ignored for normal chat while Qwen-family
  thinking is disabled. If thinking is enabled later, add a separate opt-in
  `message.assistant.thinking_delta` event and UI surface." Reasoning shipped.
  Rewrite: thinking deltas arrive on `delta.reasoning_content`, Pi persists them
  as thinking content blocks, and capability is decided by the chat template, not
  the model name.
- `plans/nelle-router-chat-ui-plan.md:225` — the `models.ini` example shows
  `c = 8192`, the exact value AGENTS.md and the architecture plan warn against.
  Change to `16384` and carry the one-line reason.
- `plans/nelle-router-chat-ui-plan.md` Runtime API Facade lists
  `PUT /api/llama/models-ini`, which was never built. Param editing lives at
  `PATCH /api/models/global-params` and `PATCH /api/models/:id`. Correct the
  facade list.
- `plans/nelle-agent-architecture.md:793` — `pnpm dev` should be `npm run dev`.
- `plans/nelle-agent-architecture.md:229-246` — the proposed repo shape lists
  `packages/{db,hf,llamacpp,pi-bridge,notifications,launcher}`, none of which
  exist, and `.claude/CLAUDE.md`, which does not exist (root `CLAUDE.md` does).
  Either mark the layout aspirational or replace it with the real one: HF search
  is `apps/server/src/huggingface.ts`, llama.cpp management is `llamacpp.ts` plus
  `llamaProxy.ts`/`llamaThroughput.ts`/`directLlama.ts`, the Pi bridge is
  `piHarness.ts`, persistence is `database.ts`/`store.ts`/`conversations.ts`, and
  `packages/shared` is the only package.
- `README.md:138-153` — "Not implemented yet" omits the first-run setup wizard,
  packaging/launcher, and the conversation list cap.

---

## Sequencing

One item per commit, docs updated in the same commit, per AGENTS.md.

1. **G11 standalone doc fixes** (`pnpm dev`, repo shape, README gaps,
   `models.ini` example, facade list). Stops the plans lying while the rest
   lands. The reasoning bullet rides with G5.
2. **G9** — one-line constant swap.
3. **G1 server** — keyset pagination, server-side search, migration 5 index.
4. **G1 web** — infinite scroll, debounced `?search=`, delete the client filter.
5. **G2 server** — `repair`, `rebuild`, `diagnostics`, unavailable-aware export.
6. **G2 web** — repair `EmptyState`, row-menu actions, rebuild confirm dialog.
7. **G5** — the event rename, coded `run.warning`, `conversation.forked`,
   `conversation.updated`. Land it before G6/G7 so new error and event work is
   written against the final names, and before it acquires a second client.
8. **G3a** — populate `model_cache`. Unblocks G4 and G6.4.
9. **G4** — honest `capabilities` plus the conversation/runtime split.
10. **G6** — the error-code set, `context_overflow` first.
11. **G7** — `tools_disabled` fail-closed.
12. **G3b** — migration 6 drops `deleted_at`.
13. **Undo toast** — the deferred-delete window (product behavior; kept separate
    from the migration above on purpose).
14. **G8** — remove the legacy default-chat surface.
15. **G10** — whatever tests did not ride along with their feature commit.

G3c needs no code.

## Settled Decisions

1. **Event names** (G5): `message.assistant.reasoning_delta`, not the router
   plan's `thinking_delta` — Nelle's public surface says _reasoning_ everywhere
   and `piHarness` is the boundary with Pi's vocabulary. `warning` becomes
   `run.warning` carrying `{code, message, detail?}` across five stable codes.
2. **`deleted_at`** (G3b): drop the column. Add a client-side undo window as a
   separate commit; server-side undo would require the soft delete we rejected.
3. **`capabilities`** (G4): the browser consumes it, under a conversation/runtime
   split. Server reports what the conversation permits; the client ANDs in live
   router state. `canAttachText` is deleted.
4. **Unavailable conversations** (G2): `repair` (revalidate) plus `rebuild`
   (reconstruct a Pi session from the projection, which holds full message text),
   plus `diagnostics` and delete. A blank `rebind` is rejected.

## Verification For Every Commit

```bash
npm run format:check && npm run lint && npm run check && npm run test:unit && npm run build:web
npm run test:e2e
```

Migrations 5 and 6 must additionally be exercised against a populated
`settings.sqlite` so the pre-migration backup path (`database.ts:313`) runs, and

`tests/unit/conversations.test.ts` must have its migration version list updated.
