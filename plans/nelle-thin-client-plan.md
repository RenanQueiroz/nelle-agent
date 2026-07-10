# Nelle Thin Client Plan

Last updated: 2026-07-09

## Purpose

Nelle will grow clients: a React Native/Expo mobile app, and probably a desktop
shell (Electron or Electrobun). Today the browser is the only client, and it
carries a large amount of logic that is not presentation. Every rule it owns is a
rule the next two clients must reimplement, identically, forever.

This plan moves that logic to the server, so a client's job is to render what it
is given and send what the user typed.

It also fixes the places where a rule is _already_ implemented twice and the two
copies disagree. Those are not future problems.

## The Test For "Should This Move?"

Three questions, in order:

1. **Does it need server data or CPU?** Extracting text from a PDF, deciding
   whether a model has been loaded. Move it to the server.
2. **Does it change the shape of what the client renders?** Turning entry
   projections into messages, deciding whether a model can reason. Move it to the
   server, so the payload is self-describing and a future non-TypeScript client
   is possible.
3. **Is it a pure helper that only TypeScript clients will ever call?** Number
   formatting, a context ratio. Put it in `packages/shared` and import it. Moving
   it to the server buys a round trip and nothing else.

Everything else — rendering, drafts, optimistic UI, scroll, clipboard,
virtualization — stays in the client. So does live run state: `canAbort` and
`canCompact` describe a run that may have started after the last snapshot, and
the client's own tracking is fresher than anything a payload can carry. That
decision is already recorded in `plans/nelle-gap-remediation-plan.md` (G4).

## Evidence: What The Browser Owns Today

Audited at commit `c52e0b8`.

### Rules that exist twice, and disagree

- **Attachment count.** `apps/web/src/utils/attachments.ts:6` allows 20 files;
  `packages/shared/src/contracts.ts:106` caps the array at 10. A user attaching
  11 files passes client validation and gets an HTTP 500 with a serialized zod
  array. Verified against the running server.
- **Default context size.** `apps/web/src/stores/settingsStore.ts:57` seeds the
  global-params editor with `{c: '8192'}`. The server's `DEFAULT_CONTEXT_SIZE` is
  `16_384` (`apps/server/src/store.ts:32`) — 8192 is the exact value AGENTS.md
  documents as clamping `max_tokens` to 1. Latent (the seed is overwritten when
  `/api/state` resolves) but wrong. `modelsMaxInput: '1'` and
  `sleepIdleInput: '90'` are duplicated the same way.
- **Context usage from performance.** The same formula
  (`usedTokens = prompt.totalTokens ?? prompt.tokens, + generation.tokens`) with
  the same `source` mapping lives in `apps/web/src/App.tsx:2056` and
  `apps/server/src/conversations.ts:1596`.
- **Router model identity.** `findRouterModelForConfiguredModel`
  (`App.tsx:149`) matches a configured model to a router entry five ways.
  `findConfiguredSectionId` (`apps/server/src/llamacpp.ts:1055`) already does the
  same join, and `getRouterModels()` returns rows _already keyed by section id_.
  The client's match is a redundant reimplementation of work the server did.
- **Vision gating, in four places.** `getDraftAttachmentError`
  (`attachments.ts:278`), the image-MIME check in `chatRequestSchema`
  (`contracts.ts:122`), `assertSupportedAttachments` in the chat route (reads
  `model_cache`), and `assertImageAttachmentsSupported`
  (`apps/server/src/piHarness.ts:1284`), which fetches llama.cpp `/props`
  directly, bypassing both the `/api/llama` facade and the `model_cache` we
  built for exactly this question.
- **Reasoning budget validation.** `parseReasoningBudgets`
  (`apps/web/src/utils/reasoning.ts:39`) hand-rolls the bound that
  `reasoningBudgetsSchema` (`packages/shared/src/reasoning.ts:43`) already
  enforces. This one is acceptable — see "What stays" — but it is a fork.

### Rules that exist only in the browser

- **`messagesFromSnapshot`** (`App.tsx:2518-2592`). A pure function of the
  snapshot encoding four rules: join attachments by `piEntryId`; hide user turns
  that a regenerate replayed; drop contentless assistant entries that ran no
  tools and produced no reasoning (Pi persists a failed turn as a ghost bubble
  and then retries); group assistant variants by
  `displayGroupId ?? regeneratesPiEntryId ?? id` and label them `variant N/M`.
- **Load-before-run** (`App.tsx:1570-1603`). `POST /api/llama/models/:id/load`,
  then poll `GET /api/llama/models` **60 times at 500 ms** watching for `failed`
  and timing out at 30 s. The runnable set is `loaded | sleeping`
  (`App.tsx:176`). `piHarness` never triggers a load; the state machine is
  entirely client-side.
- **`templateSupportsThinking`** (`utils/reasoning.ts:23`). Scans the chat
  template for `enable_thinking` / `reasoning_effort` / `thinking_budget`, or a
  `<think>` / `<thinking>` / `<|channel>thought` tag pair. The server fetches the
  template (`llamacpp.ts:185`) and ships the raw string. `piHarness.ts:1672`
  advertises `reasoning: true` for every model with a comment saying the client
  gates the UI instead.
- **Slash commands.** `parseSlashCommandName`, `parseCompactCommand`, and a
  **21-entry** `SLASH_COMMAND_GUIDANCE` table (`App.tsx:2775-2797`). The chat
  route now rejects unsupported commands (`unsupported_slash_command`), but it
  cannot tell a client which commands exist or what to suggest instead.
- **Context thresholds.** 80% warning, 100% overflow, and their copy
  (`utils/context.ts`). The server emits raw token counts and nothing else.
- **Favorites.** `window.localStorage` under `nelle.favoriteModelIds`
  (`App.tsx:129, 2818-2843`). A mobile client starts empty and can never share
  them, even though the `settings` table exists and holds exactly one key today.
- **Stream-derived state.** `isReasoning` (set on a reasoning delta, cleared on a
  content delta), the `llamacpp-timings` beats `llamacpp-slots` precedence in
  `mergeChatPerformance` (`App.tsx:2694`), and tool-call upsert-by-id
  (`App.tsx:1788`).

### Platform work that cannot be shared, only relocated

`utils/attachments.ts` mixes rules with browser APIs. The rules — limits,
truncation at 200k characters, NUL-byte binary detection, MIME/extension
classification, base64 size math — are portable. These are not:

- `renderPdfPageAttachments` (`:148-201`) renders each page through
  `document.createElement('canvas')` and `canvas.toDataURL()`. **React Native has
  no DOM canvas.** This feature cannot be ported; it can only be moved.
- `extractPdfText` (`:224-255`) needs `pdfjs-dist`.
- `readFileAsBase64` (`:257`) needs `FileReader`.

`pdfjs-dist` is _not_ in the initial bundle — `utils/attachments.ts:203` imports
it lazily and Vite code-splits it into `pdf-*.js` (415 KB) and
`pdf.worker-*.mjs` (2155 KB), fetched on first PDF attach. So the argument for
moving it is portability and rule-duplication, not startup weight. It is 36 MB
installed, which will matter when Electron packaging arrives.

## Phase 0: Fix What Is Already Wrong

**Status: done.**

Small, independent, and correct regardless of whether anything else here ships.

1. **Attachment count.** Raise `chatRequestSchema`'s array cap to 20 to match the
   documented limit, or lower the client to 10. Prefer raising: the router plan
   and `ATTACHMENT_LIMITS` both say 20. Move every limit into one exported const
   in `packages/shared` and have both sides read it.
2. **Zod failures are not `NelleError`s.** A schema failure on the chat route
   returns HTTP 500 with a serialized zod array. Add a Fastify `setErrorHandler`
   mapping `ZodError` to 400 `invalid_request` with the field path in `detail`.
   A thin client hits schema errors constantly and needs a code to branch on.
3. **`settingsStore` defaults.** Delete `DEFAULT_GLOBAL_PARAMS = {c: '8192'}`,
   `modelsMaxInput: '1'` and `sleepIdleInput: '90'`; render an empty draft until
   `/api/state` seeds it, or import the shared defaults.
4. **Stop `piHarness` bypassing the facade.** `assertImageAttachmentsSupported`
   (`piHarness.ts:1284`) `fetch`es llama.cpp `/props` directly. Route it through
   `llama.getModelProps()` and have it write `modelCache.upsertModelProps()`.
   **Behavior stays identical** — it still errors when props are unavailable.
   Only the bypass goes. Relaxing it to the cached tri-state waits for Phase 3;
   see the dependency note there.
5. **Shrink the router-model join.** `findRouterModelForConfiguredModel`
   (`App.tsx:149`) tries five ways to match a configured model to a router entry.
   Four of them are dead: `mergeRouterModels` (`llamacpp.ts:452`) seeds its map
   from `readConfiguredModelSections()` and keys every row by section id, and
   `ConfiguredModel.id` _is_ the section id (`store.ts:333`). Reduce it to
   `routerModels.find(m => m.sectionId === model.id)`. This is independent of
   Phase 3: the function itself survives, because the composer's model selector
   still needs the join for per-row status and progress (`App.tsx:404-443`).
   Only the two call sites inside the poll loop go away with Phase 3.

Exit criteria: attaching 11 files succeeds and 21 fails with a readable message;
a malformed chat body returns 400 `invalid_request`; nothing fetches llama.cpp
`/props` outside `llamacpp.ts`.

`llamaThroughput.ts:212` still fetches `/slots` directly. That is not the same
kind of bypass: AGENTS.md sanctions `/slots` as a best-effort fallback, and it is
server-internal plumbing rather than a capability question `model_cache` can
answer. Leave it.

## Phase 1: Attachment Ingestion Moves To The Server

**Status: done.**

The client posts bytes to `POST /api/uploads` and keeps the `uploadId`. The
server classifies the file, refuses a binary posing as text, extracts PDF text
with `pdfjs-dist`, truncates at 200k characters, and refuses an image for a model
llama.cpp has proven cannot see it -- when the image is chosen, not when the
message is sent. `GET /api/uploads/:id` returns the metadata and text;
`DELETE` drops an unsent draft, which is what removing a chip now does.

A chat request carries `attachments: [{uploadId}]`. `resolveChatAttachments`
decides for each PDF: a text layer is sent as text, and a scan is rendered into
page images through `@napi-rs/canvas`. The per-message caps are enforced after
that expansion, because a six-page scan is six attachments. Sent payloads still
land in the content-addressed `.nelle/attachments/` tree; drafts live in
`.nelle/uploads/<uploadId>/` and the `uploads` table (migration 8, and migration
9 for the page count), swept unbound after 24h at startup and hourly.

There was a `renderPdfAsImages` flag and a composer switch behind it; both are
gone. The server knows the document and the model, and the client knows neither.

`pdfjs-dist` has left the web app: the bundle is 820 KB in two files, with no
`pdf-*` chunk and no 2 MB worker, and `tests/unit/webBundle.test.ts` keeps it
that way. The client keeps the file picker, drag/drop, paste, the drawer, the
progress spinner, and its own conservative image gate.

Verified against the real server and model: a text file and a PDF attached
through the browser, uploaded, referenced by id, extracted server-side, and
answered correctly from both. A three-page PDF rendered to page images reaches
the model as three PNGs.

## Phase 2: The Snapshot Returns Messages, Not Entries

**Status: done.**

`messagesFromSnapshot` is a pure function of the snapshot. Move it to
`packages/shared/src/messages.ts` and call it from
`ConversationRepository.getSnapshot()`, so the snapshot grows a `messages` array
alongside `entries`.

Both halves of the goal are met: the code is shared, and the payload is
self-describing for a client that cannot import TypeScript.

Keep `entries` — a future branch explorer needs the raw projection — but nothing
in a normal client should read it.

The client still folds live deltas while a message is streaming. That is
unavoidable and small: `message.assistant.completed` already carries the final
resolved message, so the fold only has to survive until the turn ends.

### Tests

Port the four rules from the browser into unit tests against the shared function:
replayed user turns hidden, ghost assistant entries dropped (but not ones with a
thinking block), variants grouped and labelled, attachments joined.

## Phase 3: The Server Loads The Model

**Status: done.**

Delete `waitForRouterModelReady` and `ensureModelReadyForRun` from the client.

`POST /api/conversations/:id/chat/stream` and `.../regenerate` ensure the
requested model is runnable before they start a run:

- If the router reports `loaded` or `sleeping`, proceed.
- Otherwise `POST /models/load`, then watch the router until it is runnable, it
  reports `failed`, or a 30 s deadline passes. Reuse the deadline and the
  runnable set (`loaded | sleeping`) verbatim; they are the current behavior.
- Emit progress on the run stream so the client can keep showing
  `Loading weights NN%` without owning the state machine:

```ts
{type: 'model.loading', modelId, status, progress?: number}
```

Failure maps to `model_load_failed`, which already exists.

The two calls to `findRouterModelForConfiguredModel` inside the poll loop go away
with it. The function itself stays, shrunk by Phase 0: the composer's model
selector still joins configured models to router rows for per-row status and
progress (`App.tsx:404-443`).

### Fetch props after a successful load — this unblocks the vision gate

Today the _only_ writer of `model_cache`'s modality and context columns is the
`GET /api/llama/models/:id/props` route (`server.ts:291`). It fills the cache
because a client asked. Once the server loads models itself, nothing asks, and
`modelCache.getVisionSupport()` stays `null` forever for any client that never
calls that route — which is exactly the thin client this plan is building.

So a successful server-side load must call `llama.getModelProps()` and
`modelCache.upsertModelProps()` before the run starts. Without that step:

- Phase 4's `canReason` is `null` for every model on a fresh client.
- Phase 1's vision gate can never tighten, because `getVisionSupport()` never
  leaves `null`, and `null` means "allow".

With it, `assertImageAttachmentsSupported` can finally be deleted rather than
merely un-bypassed: by the time attachments are prepared, the model is loaded and
its props are cached. That deletion belongs here, not in Phase 1.

### Tests

- Unit: chat against an `unloaded` model issues one load and streams
  `model.loading` before `run.started`; a `failed` model errors with
  `model_load_failed`; a `sleeping` model loads nothing.
- Unit: after a server-side load, `model_cache` holds modalities and context
  window for that model without any client having called the props route.
- E2e: the composer shows load progress from server events, with no
  `/api/llama/models` polling in the network log.

## Phase 4: Derived Capabilities Move Into The Payload

### Phase 4a — `canReason`

**Status: done.**

`templateSupportsThinking` moved to `packages/shared/src/reasoning.ts`.
`LlamaCppManager.getModelProps()` calls it and returns
`LlamaModelProps.canReason: boolean | null`; migration 7 added
`model_cache.can_reason`, written by `upsertModelProps` and read by
`ModelCacheRepository.getReasoningSupport()`, which feeds
`snapshot.capabilities.canReason`. `null` keeps its meaning: llama.cpp has never
reported a template, so the control stays editable. The client prefers live props
and falls back to the snapshot capability; `apps/web/src/utils/reasoning.ts` now
holds only `parseReasoningBudgets`.

Verified against the real router: gemma-4-26B's template declares
`enable_thinking`, so `/api/llama/models/:id/props` answers `canReason: true`,
`model_cache.can_reason` becomes `1`, and the conversation snapshot reports
`canReason: true` with no client-side template parsing.

### Phase 4b — the rest

**Status: done.**

- **Context thresholds.** `packages/shared/src/context.ts` owns
  `CONTEXT_WARNING_RATIO = 0.8` and `CONTEXT_OVERFLOW_RATIO = 1`, and
  `ConversationContextUsage.status` is `ok | warning | overflow`. The server
  stamps it through `withContextStatus` on both exits -- `buildContextUsage` for
  snapshots and `createContextUpdatedEvent` for the stream. The client picks a
  colour from the status, falling back to the shared thresholds for payloads
  written before the field existed.
- **Context usage from performance.** `contextUsageFromPerformance` and
  `mergeLiveContextUsage` are gone from `App.tsx`. Both harnesses run a
  `createLiveContextTracker` that emits `context.updated` during the run. It
  throttles to one event per 250ms -- generation grows `usedTokens` by one per
  token, so an unthrottled tracker put one event on the wire per token -- but
  always emits when the usage crosses a threshold, so the bar recolours at once.
- **`isReasoning`.** Carried on `message.assistant.delta` (`false`) and
  `.reasoning_delta` (`true`). Verified on a real thinking run: 900 reasoning
  deltas, then 359 answer deltas, one transition, none mislabelled.
- **Performance merge.** Both harnesses already merged into the assistant message
  before emitting, so the client was merging an already-merged payload with a
  second, subtly different rule. The client now assigns. `mergeChatPerformance`
  and `performanceFromLlamaTimings` gained the tests they never had.

Two bugs surfaced while verifying this phase against the real server, and were
fixed on their own commits: `Stop` raised
`Cannot read properties of undefined (reading 'catch')` and never aborted the
run, and the first cut of the live context tracker flooded the stream.

## Phase 5: Server-Owned Command Registry

**Status: done.**

```http
GET /api/commands
  -> {commands: [{name: '/compact', argHint: '[instructions]',
                  description: 'Compact this conversation context'}],
      unsupported: [{name: '/model', guidance: 'Use the model selector…'}, …]}
```

`packages/shared/src/commands.ts` owns the allowlist, the 21 guidance entries,
`parseSlashCommandName`, `parseCompactCommand`, and
`unsupportedSlashCommandMessage`. The chat route's `assertSupportedSlashCommand`
and the composer's refusal now render the same string from the same table, and
the client takes the registry from `GET /api/commands`, falling back to the
bundled copy only until that request resolves. Allowlisting a command server-side
needs no client release, which is what the e2e test pins.

Client keeps: the typeahead widget, and the local interception that routes
`/compact` to the compact endpoint rather than the chat endpoint.

## Phase 6: Preferences Follow The User

**Status: done.**

Favorite model ids moved from `localStorage` to the `settings` table under a
`preferences` key, served by `GET`/`PATCH /api/settings/preferences`.

A favorite whose model has left `models.ini` is filtered out of the response but
not deleted from storage, so a model that comes back brings its star with it. A
browser that starred models before this existed hands them over on first load and
then drops its local copy, so a favorite removed on another client cannot be
resurrected by an old browser profile.

Everything else in `settingsStore` and `uiStore` is genuinely client-local:
sidebar collapse, open settings section, search text, drafts.

## What Stays In The Client

Do not move these. Moving them costs a round trip and buys nothing.

- Rendering, layout, and formatting (`utils/format.ts`,
  `utils/conversationRows.ts`).
- Scroll behavior (`utils/chatScroll.ts`).
- Composer drafts, attachment drafts, PDF-as-image toggle (`composerStore`).
- The delete undo window (`utils/pendingDeletes.ts`). There is no soft delete;
  the deferral and the `pagehide` flush are browser-lifecycle concerns and a
  React Native client will express them differently.
- Optimistic row hiding, page dedupe, and the stale-request guard in
  `conversationsStore`. These are list-consistency concerns of a UI, not rules.
- `parseReasoningBudgets`. It is string-to-number parsing for a text input. The
  _rule_ (`MAX_REASONING_BUDGET`) is already imported from `packages/shared`; the
  parser can stay forked because the web bundle is deliberately zod-free.
- `canAbort` / `canCompact`, per G4.

## Sequencing

One item per commit, docs updated in the same commit.

1. **Phase 0** — five independent fixes. Three are live bugs; two are cleanups
   that remove a facade bypass and a redundant join. None depend on anything
   else here.
2. **Phase 2** — `messagesFromSnapshot` into `shared` + the snapshot. Pure, zero
   risk, immediate payoff. Do it before anything that touches the transcript.
3. **Phase 3** — server-owned model loading, _and_ caching props after a load.
   Moved up: it is the prerequisite for the two phases below, because nothing
   else fills `model_cache` once clients stop asking for props.
4. **Phase 4a** — `canReason` into model props and `model_cache`. Small, deletes
   a whole client module. Needs Phase 3, or it reports `null` for every model.
5. **Phase 4b** — context status, `isReasoning`, performance merge.
6. **Phase 5** — command registry.
7. **Phase 6** — preferences.
8. **Phase 1** — attachment ingestion. Last, not first: it is the only phase that
   adds a table, a directory, a retention job, and a native dependency, and it
   benefits from everything above already having proved the shape of the
   contract. It also needs Phase 3 for the vision gate to mean anything.

Phase 1 is last on purpose. It is the most valuable change and the most
disruptive one, and the earlier phases are cheap enough that waiting costs
nothing.

The one hard dependency in this plan is **Phase 3 before Phase 4a and Phase 1**.
`model_cache`'s props columns are written by exactly one caller today — the props
route, invoked by a client. Take that client away without giving the server a
reason to fetch props, and every capability derived from them silently degrades
to "unknown".

## Risks

- **Native canvas.** `@napi-rs/canvas` ships prebuilt binaries for the platforms
  Nelle targets, but it is a native module and Milestone 6 has to package it.
  Verify on Windows and macOS before committing to it; `pdftoppm` is the escape
  hatch, at the price of a managed binary.
- **Upload retention.** Draft uploads are the first server-side state with no
  owner. A missing sweep silently fills the disk. The sweep must exist in the
  same commit as the endpoint, not after it.
- **Payload growth.** Adding `messages` to the snapshot duplicates `entries` on
  the wire. Measure before worrying; a conversation is tens of kilobytes, and
  `entries` can be dropped from the default response later behind a query
  parameter.
- **Streaming still needs a client-side fold.** Nothing here removes it. The goal
  is that the fold be mechanical — append a delta, replace on completion — with
  no rules in it.

## Verification For Every Commit

```bash
npm run format:check && npm run lint && npm run check && npm run test:unit && npm run build:web
npm run test:e2e
```

Phase 1 must additionally assert that `dist/web/assets/` contains no `pdf-*`
chunk, and that a freshly created upload is swept after its TTL.
