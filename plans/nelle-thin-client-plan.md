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

The largest change, and the only genuinely architectural one.

### Today

The browser reads the file, extracts PDF text with `pdfjs-dist`, optionally
renders pages to PNG data URLs through a canvas, base64-encodes images, enforces
the limits, and posts the _results_ embedded in the chat request
(`chatAttachmentInputSchema` carries `text` and `data`). The server never sees the
original bytes.

### Target

The client uploads bytes and references them by id.

```http
POST /api/uploads                      multipart/form-data
  -> 201 {uploadId, kind, name, mimeType, sizeBytes,
          textPreview?, pageCount?, warnings[]}

GET  /api/uploads/:uploadId            metadata + extracted text (paged)
DELETE /api/uploads/:uploadId          drop an unsent draft attachment
```

The chat request changes from embedded payloads to references:

```ts
attachments: Array<{uploadId: string; renderPdfAsImages?: boolean}>;
```

The server owns: classification (`isImageFile`/`isPdfFile`/`isTextFile`), NUL-byte
binary rejection, MIME inference, PDF text extraction, PDF→PNG rendering,
truncation at 200k characters, all five limits, and the vision gate. `pdfjs-dist`
is already a root dependency, so text extraction needs nothing new. Rendering
needs a Node canvas: prefer `@napi-rs/canvas` (prebuilt binaries, no system
deps) over `node-canvas`; `pdftoppm` is a fallback if a native module proves
painful to package.

### Retention

Uploads are draft state and must not leak. The router plan already anticipates
this: _"any future server temp-upload API must add startup and periodic retention
cleanup."_

- Store under `.nelle/uploads/<uploadId>/`, distinct from the content-addressed
  `.nelle/attachments/` tree that holds _sent_ payloads.
- Row in a new `uploads` table: `id`, `conversation_id?`, `kind`, `name`,
  `mime_type`, `size_bytes`, `storage_path`, `text_content?`, `created_at`,
  `bound_at?`.
- On send, the existing `createPendingAttachments` /`bindAttachmentsToEntry`
  path (`conversations.ts:505, 641`) consumes the upload and moves its bytes into
  the content-addressed store; the upload row is marked bound.
- Sweep unbound uploads older than 24 h at startup and hourly. Extend the
  existing `sweepOrphanAttachmentFiles` (`server.ts:1181`) rather than adding a
  second sweeper.
- `DELETE /api/conversations/:id` already removes unreferenced attachment files;
  uploads bound to it go the same way.

### Consolidate the vision gate

By the time this phase lands, `assertImageAttachmentsSupported` should already be
gone: Phase 0 removes its bypass of the facade, and Phase 3 deletes it once a
server-side load guarantees the props are cached. What is left for this phase is
to make the **upload endpoint** consult `modelCache.getVisionSupport()` too, so an
image is rejected when it is chosen rather than when the message is sent.

That leaves two gates, which is the right number: the upload endpoint refuses an
image for a model llama.cpp has _proven_ cannot see it, and the client keeps its
own conservative UI gate (it blocks images while props are unknown, because the
user can simply load the model). `null` means unproven, not text-only, and the
server never rejects on a guess.

### What the client keeps

The file picker, drag/drop, paste, the drawer, and the progress spinner. It
posts bytes and renders what comes back. `pdfjs-dist` leaves the web app
entirely.

### Tests

- Unit: classification, binary rejection, truncation, limits, and PDF text
  extraction, all server-side, ported from `tests/unit/attachments.test.ts`.
- Unit: a PDF renders to N page images; `renderPdfAsImages` on a model whose
  `model_cache` vision is `false` is rejected with `unsupported_attachment`;
  `null` passes.
- Unit: an unbound upload older than the TTL is swept; a bound one is not.
- E2e: attach a PDF, send, and see the pages; the web bundle no longer contains
  a `pdf-*.js` chunk.

## Phase 2: The Snapshot Returns Messages, Not Entries

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

- **`canReason`.** Compute `templateSupportsThinking(chatTemplate)` in
  `LlamaCppManager.getModelProps()`, persist it in `model_cache`, and expose it
  as `LlamaModelProps.canReason: boolean | null` and
  `snapshot.capabilities.canReason`. `null` keeps its meaning: llama.cpp has
  never reported a template, so the control stays editable. Delete
  `apps/web/src/utils/reasoning.ts`'s detector.
- **Context thresholds.** Put `CONTEXT_WARNING_RATIO = 0.8` and
  `CONTEXT_OVERFLOW_RATIO = 1` in `packages/shared`, and add
  `status: 'ok' | 'warning' | 'overflow'` to `ConversationContextUsage`, computed
  server-side in `buildContextUsage` and on every `context.updated`. The client
  picks a colour from the status instead of recomputing the ratio.
- **Context usage from performance.** Delete `contextUsageFromPerformance` and
  `mergeLiveContextUsage` from `App.tsx`. The server already computes this
  (`conversations.ts:1596`); have it emit `context.updated` during the run rather
  than only after compaction.
- **`isReasoning`.** The server knows which phase a turn is in. Carry it on
  `message.assistant.reasoning_delta` / `.delta`, or emit a
  `message.assistant.phase` event. The client stops inferring it from event
  order.
- **Performance merge.** The `llamacpp-timings` beats `llamacpp-slots` precedence
  belongs next to the code that produces both, in `llamaThroughput.ts`. Emit
  merged `performance.updated` payloads; the client assigns rather than merges.

## Phase 5: Server-Owned Command Registry

```http
GET /api/commands
  -> {commands: [{name: '/compact', argHint: '[instructions]',
                  description: 'Compact this conversation context'}],
      unsupported: [{name: '/model', guidance: 'Use the model selector…'}, …]}
```

The chat route already rejects unsupported commands with
`unsupported_slash_command` (see G6). This gives the client the typeahead source
and the guidance copy it currently hardcodes in a 21-entry table, and it means a
new allowlisted command ships without touching any client.

Client keeps: the typeahead widget, and the local interception that routes
`/compact` to the compact endpoint rather than the chat endpoint.

## Phase 6: Preferences Follow The User

Favorite model ids move from `localStorage` to the `settings` table, which
already has the right key/value shape and holds only `hostTools` today.

```http
GET   /api/settings/preferences  -> {favoriteModelIds: string[]}
PATCH /api/settings/preferences
```

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
