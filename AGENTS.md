# AGENTS

Project-specific guidance for AI coding agents.

## Project Rules

- Keep documentation current with every repository change. Update `README.md`,
  `plans/nelle-agent-architecture.md`, and `AGENTS.md` whenever implementation
  behavior, setup commands, architecture, or workflow expectations change.
- `AGENTS.md` is the single source of truth for shared agent guidance. Root
  `CLAUDE.md` should contain only `@AGENTS.md`.
- Use a Node version matching `package.json` `engines` before running npm
  commands.
- Primary checks are `npm run format:check`, `npm run lint`, `npm run check`,
  `npm run test:unit`, `npm run build:web`, `npm run test:e2e`, and
  `npm test`.
- Formatting and linting use Oxfmt and Oxlint. Run `npm run format` for
  formatter writes and `npm run lint:fix` for safe lint fixes.
- Run Playwright e2e tests for UI behavior changes when possible. The e2e
  server uses `.nelle-e2e/` and starts on `127.0.0.1:8799`.
- Codex has a local Playwright MCP server configured in `~/.codex/config.toml`;
  restart the Codex session after MCP config changes.
- Nelle stores app data under `.nelle/` by default. Do not commit
  generated app data, e2e app data, downloaded models, llama.cpp builds, test
  reports, or logs.
- `.nelle/settings.sqlite` is generated app data. It stores conversation rows,
  active-branch projections, and Nelle-only sidecar metadata; do not commit it.
- `.nelle/backups/` contains generated SQLite migration backups; do not commit
  it.
- Hugging Face GGUF `hf-repo` refs stay exact, but llama.cpp router sections and
  OpenAI `model` ids use llama.cpp-canonical quant tags. Every model is written
  to `.pi/models.json` with `reasoning: true` and Pi's `qwen-chat-template`
  compatibility, which is Pi's name for "send
  `chat_template_kwargs.enable_thinking`". Whether a model can actually think is
  a property of its chat template, not its name, and the server decides:
  `LlamaCppManager.getModelProps()` runs shared
  `templateSupportsThinking(chatTemplate)` and reports `canReason`, which is
  cached in `model_cache.can_reason` and surfaced as
  `snapshot.capabilities.canReason`. Clients read that answer; they never
  re-derive it from the template, and never gate on a `qwen` substring.
- Generated llama.cpp presets omit `n-gpu-layers` by default. Only write GPU
  offload flags when the user explicitly configures them.
- Launch llama-server with configurable `modelsMax` and `sleepIdleSeconds`
  settings. Defaults are `1` and `90`, and changes require a server restart.
- The default context size is 16384, not llama.cpp's own default. Pi's agent
  system prompt costs ~4k tokens and Pi's `clampMaxTokensToContext` reserves
  another 4096 before allocating any reply tokens, so an 8k window clamps
  `max_tokens` to 1 and every answer stops after one word with
  `finish_reason: "length"`. Keep the arithmetic in
  `packages/shared/src/piContext.ts` and warn when the reply budget is exhausted.
- Never advertise a fixed `maxTokens` to Pi. Scale it with the context window
  (`replyTokenBudget`); Pi clamps it down against the live context anyway.
- Pi charges a flat `PI_ESTIMATED_IMAGE_TOKENS` (1200) against its context
  estimate for every image, whatever the picture, while llama.cpp spends about
  120 on a rendered PDF page. With Pi's ~9.4k system prompt and its 4,096-token
  reserve, the default 16,384 window fits exactly two images: the third clamps
  `max_tokens` to 1, llama.cpp returns one token, and the turn ends with no
  answer. Nelle's llama.cpp proxy is the only place that number is visible, so
  `beginLlamaRequestCapture` reads it off the wire and `emptyAnswerError` turns
  the empty turn into `reply_budget_exhausted` instead of a bare
  `pi_run_failed`.
- Derive throughput from token counts and elapsed milliseconds. llama.cpp
  reports `predicted_per_second: 1000000` for a single token generated in
  "0.00 ms", so its own rate fields must not be trusted, and a burst shorter
  than a millisecond has no measurable rate at all.
  `prompt.totalTokens` is the whole prompt -- `prompt_n` plus the reused
  `cache_n` prefix -- because context usage reads it. `prompt.tokens` stays the
  processed count the Reading widget shows. Dropping the cache made a
  9,715-token prompt read as 382 in the context bar.
- The e2e harness sets `NELLE_LLAMA_PORT=18080`. The runtime status probe treats
  any healthy server on the configured port as a running llama.cpp, so leaving
  e2e on 8080 makes the suite adopt a developer's real llama-server.
- Do not reintroduce local GGUF path registration or Nelle-owned model downloads
  in the active product; model imports are Hugging Face `hf-repo` entries.
- The web app uses React Compiler through `@vitejs/plugin-react`'s
  `reactCompilerPreset()` and `@rolldown/plugin-babel` in
  `apps/web/vite.config.ts`.
- Nelle persists managed llama-server ownership in
  `.nelle/llama/llama-server.pid.json` so restarted servers can adopt and stop
  the prior router process.
- Browser/server UI code should use Nelle's `/api/llama/*` router facade for
  llama.cpp props, models, load/unload, reload, model props, and router events.
  Do not call llama.cpp directly from the web app.
- Runtime settings should show router-reported loaded/maximum model capacity
  from `/api/llama/props`; let llama.cpp enforce model scheduling.
- `/api/llama/tokenize` proxies llama.cpp `/tokenize` for text-only estimates.
  Post-compaction context refreshes persist the estimate in
  `conversations.context_usage_json` and stream a `context.updated` event.
- Each Nelle conversation maps to one Pi session JSONL file. Treat Pi session
  files as authoritative for message history, compaction, and branch state;
  SQLite stores conversation indexes, projections, and Nelle-only sidecar
  metadata.
- Projection sync may rebuild the active SQLite view from Pi's current branch,
  but must not rewrite the Pi session file or drop inactive branches from the
  append-only JSONL history. A sync with no regenerate metadata -- a snapshot
  refresh, a restart -- must still keep the variant rows the projection already
  holds. `getBranch()` walks only the active path, so a metadata-less rebuild
  rediscovers each group from the branch entries' own `regeneratesPiEntryId`.
  Without that, the first snapshot read after a regenerate drops the older answer,
  and the prompt vanishes with it: it is hidden as a replayed user turn, leaving
  a bare reply on screen.
- Conversation snapshot reads should refresh the active projection from the
  bound Pi session file when possible. After a server restart, stale
  `running`/`compacting`/`aborting` rows without an active in-memory run should
  recover to `ready` rather than staying stuck.
- API-created conversations should immediately create and bind a header-only Pi
  session JSONL file, before the first prompt.
- The default conversation id is `legacy-default`. It was `poc-default` until
  schema migration 3 renamed it, along with every table whose `conversation_id`
  references it. Those tables declare foreign keys without `ON UPDATE CASCADE`
  and the connection runs with `PRAGMA foreign_keys = ON`, so any rename of a
  conversation id must `PRAGMA defer_foreign_keys = ON` inside the migration
  transaction or it orphans the children mid-statement.
- `syncLegacyDefaultConversationFromState` only migrates a non-empty legacy
  `.nelle/state.json` chat; it must never create `legacy-default` from nothing.
  Read paths such as `GET /api/conversations` call it, so creating a placeholder
  there resurrects the conversation right after the user deletes it. Deleting
  every conversation is allowed and leaves an empty sidebar with a blocked
  composer.
- On Pi-enabled startup, migrate a non-empty legacy default chat from
  `.nelle/state.json` into a real Pi session before validating existing
  bindings. Direct llama.cpp fallback may still force-refresh the legacy
  projection for compatibility.
- Validate existing Pi session bindings before opening a runtime. Missing or
  malformed session files must mark the conversation `unavailable` and surface
  `session_unavailable`; no read path may create a replacement session under the
  same conversation id.
- Conversation snapshot `capabilities` describe what the *conversation* permits,
  never the runtime: `canSend` is `status === 'ready'`, and whether llama.cpp is
  up or a model is selected is the client's half of the check. `canAttachImages`
  is a tri-state from `model_cache` (`null` = never loaded, so unknown).
  `canAbort`/`canCompact` are point-in-time; a client tracking live run state
  should prefer its own. The browser reads `canRepair`, which stays true until a
  repair or rebuild succeeds.
- `unavailable` conversations recover through three explicit endpoints, never
  implicitly. `POST /api/conversations/:id/repair` re-checks the file and only
  succeeds if the user restored it. `POST /api/conversations/:id/rebuild`
  reconstructs a Pi session from `conversation_entry_projection`, which despite
  the column name `text_preview` stores the full message text; it is lossy and
  the UI must say so, dropping tool results, image content, compaction summaries,
  and regenerate variants. `GET /api/conversations/:id/diagnostics` explains what
  is wrong. Rebuild must remap `message_attachments.pi_entry_id`, because Pi
  hands out new entry ids.
- Exporting an `unavailable` conversation is allowed and sets
  `manifest.piSessionMissing`; importing such an archive is rejected with
  `archive_session_missing` rather than producing an empty conversation.
- Chat UI streaming uses `/api/conversations/:id/chat/stream`. The legacy
  `/api/chat/stream` and `/api/chat/messages` endpoints have been removed, and
  `syncLegacyDefaultConversationFromState` runs only at startup and from the
  direct-llama fallback -- never from a read path. Pi no longer mirrors messages
  into `state.json.chat[]`; only `directLlama` writes it, because the fallback
  runs when Pi is unavailable and has no session file to persist into.
- Implement conversation fork/duplicate through Pi
  `SessionManager.createBranchedSession()`, creating a new Nelle conversation
  for the new Pi session file, copying retained Nelle sidecar metadata, and
  leaving the source conversation unchanged.
- Browser v1 uses REST for commands/snapshots and SSE streams with typed Nelle
  event envelopes. UI stop/abort calls Pi `AgentSession.abort()`; Nelle's
  llama.cpp proxy forwards request/response close events to the upstream fetch
  `AbortSignal`.
- Chat/regenerate streams are serialized as Nelle SSE envelopes, and the envelope
  `type` mirrors the inner event's `type`, so the `ChatStreamEvent` union member
  names are the wire contract. Every event is dotted:
  `run.started`/`run.aborted`/`run.completed`/`run.warning`,
  `message.user.created`, `message.assistant.started`/`.delta`/
  `.reasoning_delta`/`.completed`, `performance.updated`, `tool_call.updated`,
  `conversation.updated`, `context.updated`, `compact.*`, `error`. The legacy
  `done` alias is gone. Preserve the envelope reader's backward compatibility
  with raw (unwrapped) payloads: that fallback is about envelope shape, not
  names, and the e2e mocks rely on it.
- `run.warning` carries `{code, message, detail?}`, not bare prose. The codes live
  in `NELLE_WARNING_CODES`. A browser can render a sentence; no other client can
  branch on one, localize it, or suppress a warning it already knows about.
- `conversation.forked` is specified by the router plan but deliberately not in
  the union: fork and clone are plain JSON routes and Nelle has no
  conversation-level SSE channel, only per-run streams. Add it with that channel,
  not before.
- Stream `error` events must carry stable `NelleError` fields (`code`,
  `message`, optional `detail`/`retryable`/`logRef`); do not emit message-only
  errors from new server stream paths. Every code lives in `NELLE_ERROR_CODES`
  (`packages/shared/src/contracts.ts`); add new ones there so a second client can
  know what it may see.
- The chat route enforces the same three guards as the composer, because
  enforcing them only in the browser leaves every other client able to bypass
  them: `unsupported_slash_command` (only `/compact`, and it has its own
  endpoint), `llama_server_stopped`, and `unsupported_attachment` (an image sent
  to a model `model_cache` has *proven* cannot see; `null` means unproven, so it
  passes).
- `context_overflow` is detected by matching llama.cpp's
  `"type":"exceed_context_size_error"`, which it emits with `n_prompt_tokens` and
  `n_ctx` both as a 400 body and as an in-stream `error` chunk
  (`tools/server/server-task.cpp`). Nelle's proxy relays it verbatim, so the
  match happens in `normalizeNelleError` wherever the text resurfaces.
- `models.ini` editing should use a lossless AST parser/writer that preserves
  comments, ordering, unknown keys, and untouched user edits. Keep exact
  `hf-repo` refs while deriving stable canonical section ids for router/OpenAI
  model ids.
- `models.ini` is the active model catalog and free-form params source of
  truth. `AppStore` refreshes model records from parsed `models.ini` before
  returning model state; `.nelle/state.json` mirrors the catalog only as a
  compatibility backup.
- New conversations default to `max` reasoning. `enable_thinking` is an inert
  kwarg on a template that does not declare it, and `max` sends no budget, so
  the default needs no per-model branch: a non-thinking model behaves exactly as
  it did with `off`. Conversations created before migration 4 keep the `off` it
  gave them. Forks and clones inherit their source's level.
- The composer's reasoning selector reads `canReason` as a tri-state, preferring
  live props and falling back to `snapshot.capabilities.canReason`. llama.cpp
  answers `/props` only for a model it has loaded at least once, so `null` means
  "not known yet" and must stay editable; only a template that provably has no
  thinking mode (`false`) locks the control to `off`.
- Reasoning is per conversation (`conversations.reasoning_level`, one of `off`,
  `low`, `medium`, `high`, `max`) and drives Pi's thinking level:
  `createAgentSession({thinkingLevel})` at session creation and
  `session.setThinkingLevel()` before every prompt, so a cached session picks up
  an on-the-fly change. Nelle's `max` maps to Pi's `xhigh`.
- llama-server, not Nelle, separates thinking from the answer: thinking arrives
  as `delta.reasoning_content` and reaches the UI as
  `message.assistant.reasoning_delta` events, which carry `isReasoning: true`
  while `message.assistant.delta` carries `isReasoning: false`. The server states
  the phase; clients must not infer it from the order events arrive in. The wire
  contract says *reasoning*,
  matching `reasoning_level`, `reasoning_text`, and the REST routes; Pi's
  internals say *thinking*, and `piHarness` is the boundary between the two.
  Pi persists it as `{type: 'thinking'}` content blocks, which stay
  authoritative for a conversation's reasoning history. Do not parse thinking
  tags out of message text. The one exception is
  `stripLeadingThinkingEndTag`: when a budget forces the block closed,
  llama.cpp hands the model its own end tag and then passes everything through
  as content, and the model usually echoes that tag as its first answer token.
- Reasoning budgets are global (`state.reasoning.budgets`, defaulting to
  llama.cpp's own 512/2048/8192) and reach llama.cpp as the top-level
  `thinking_budget_tokens` field, injected through Pi's `agent.onPayload` hook.
  Pi's own `thinkingBudgets` setting never reaches an OpenAI-completions
  provider, and neither `reasoning_budget` nor
  `chat_template_kwargs.thinking_budget` has any per-request effect. The `max`
  level and a budget of `0` both mean "send no budget".
- Runtime/model/reasoning/global/chats controls live in the modal Astryx
  Settings dialog. Settings writes free-form string params into `models.ini`
  through server APIs,
  reloads router models when llama-server is running, and keeps the persisted
  stable section id as the llama.cpp/OpenAI model id.
- The settings dialog is a fixed size (`min(92vw, 1040px)` by
  `min(85vh, 760px)`): responsive to the viewport, but never resized by the
  section the user is on. Astryx `Dialog` is `height: fit-content`, so the height
  is pinned through an inline style, and each section scrolls inside
  `LayoutContent`. Separate items inside a section with `Divider`, not `Card`;
  cards inside a modal section read as boxes within boxes.
- Conversation snapshots carry `messages` as well as `entries`. `messages` is
  what a client renders, built by `buildConversationMessages`
  (`packages/shared/src/messages.ts`): it hides user turns a regenerate replayed,
  drops contentless assistant entries that ran no tools and produced no
  reasoning, groups regenerate variants by
  `displayGroupId ?? regeneratesPiEntryId ?? id` and labels them `variant N/M`,
  and joins attachments by `piEntryId`. `entries` stays for a future branch
  explorer; nothing in a normal client should read it. The e2e mock builds its
  `messages` with the same function so it cannot drift.
- `packages/shared/src/attachments.ts` (the limits) must stay zod-free: the web
  app imports it directly and the bundle carries no zod. `attachmentMetadata.ts`
  exists so `conversations.ts` and `messages.ts` can both import the metadata
  schema at runtime without becoming circular.
- Keep `apps/web/src/App.tsx` focused on app orchestration. Put extracted UI
  surfaces under `apps/web/src/components/`, shared client state under
  `apps/web/src/stores/`, shared types in `apps/web/src/types.ts`, and shared
  presentation helpers under `apps/web/src/utils/`.
- Use Zustand for cross-cutting browser UI state, with narrow selectors so
  unrelated UI does not rerender when a slice changes.
- Preferences that should follow the user live in the `settings` table under the
  `preferences` key and are served by `GET`/`PATCH /api/settings/preferences`.
  Favorite model ids are the first of them; do not put them back in
  `localStorage`. A favorite for a model missing from `models.ini` is filtered
  from the response, never deleted from storage. Genuinely client-local state --
  sidebar collapse, open settings section, search text, drafts -- stays in the
  browser stores.
- Settings dialog draft state, search results, runtime input fields, and log
  visibility/output live in `apps/web/src/stores/settingsStore.ts`. Do not move
  modal draft fields back into `App.tsx`.
- A settings draft is what the user is typing, so only the save that made it
  stale may overwrite it. `refreshState()` runs after every save and after model
  activation, so it must not re-seed drafts: it only calls
  `reconcileModelDrafts`, which adds and drops whole models. Seeding happens once
  on load; each save calls the matching `reset*` with the values the server
  returned.
- Composer draft text, attachments, PDF-as-image mode, and composer
  error/warning/slash status live in `apps/web/src/stores/composerStore.ts`, and
  the composer surface is `apps/web/src/components/chat/ChatComposerPanel.tsx`.
  The conversation search box lives in `uiStore`; the list it searches lives in
  `apps/web/src/stores/conversationsStore.ts`. Keep them out of `App.tsx` so
  typing and stream status updates do not rerender the chat transcript.
- `GET /api/conversations` is keyset-paginated and returns
  `{conversations, nextCursor?, total}`. The cursor walks `(updated_at, id)`
  descending; the `id` is not decoration, because two conversations touched in
  the same millisecond tie on `updated_at` and a cursor without it drops a run of
  rows at the page boundary. Pinned rows ride along on the first page only.
  Never paginate by FTS `rank`: rank shifts as rows enter the index, so pages
  overlap.
- Conversation search is a server query, never a filter over the loaded page.
  The sidebar holds a window onto the list, so filtering it client-side reports
  "no matching chats" for every conversation the user has not scrolled to.
  Section headers and the Settings chat count must render `total`, not the
  number of rows paged in.
- Model param update payloads are full replacements for editable params in a
  section. Preserve a free-form key by including it in the submitted key/value
  draft; omit it to delete it.
- The composer model selector is compact but router-aware: it is searchable,
  groups browser-local favorites first, shows selected/row router
  status/progress from router SSE updates, and loads unloaded router models
  before activating them.
- The **server** loads the model. `POST /api/conversations/:id/chat/stream` and
  `.../regenerate` call `LlamaCppManager.ensureModelRunnable()` before the run
  starts, streaming `model.loading` events while they wait, and failing with
  `model_load_failed`. A model the router does not list is left alone. Clients do
  not poll `/api/llama/models`; the composer's model selector may fire a load and
  walk away, because the run waits.
- A successful server-side load must fetch and cache the model's props.
  `GET /api/llama/models/:id/props` is otherwise the only writer of
  `model_cache`'s modality and context columns, and it fires because a client
  asked. A thin client never asks, so without this every capability derived from
  props -- `canAttachImages`, `canReason` -- silently degrades to "unknown".
- Settings rows for models with active runs must show an active-run token and
  keep unload/save/remove disabled until a terminal run event arrives.
- Browser chat run state is conversation-scoped. Use per-conversation run-kind
  state and abort controllers, keep inactive stream deltas out of the visible
  transcript, and allow a ready conversation to send while another conversation
  is still running.
- Ongoing conversations in the sidebar use an Astryx `Spinner` plus status text,
  not only a status dot, so users can spot running agents after switching chats.
- `model_cache` is Nelle's server-side record of what the router last said about
  each `models.ini` section. `GET /api/llama/models` writes status/alias/hf-repo;
  `GET /api/llama/models/:id/props` writes modalities and context window on
  success only. It is a cache, never a source of truth: the router wins when it
  is up, a stopped llama-server leaves the rows alone (`updated_at` expresses
  staleness), and removing a section from `models.ini` prunes its row. A model
  that has never been loaded has no props, so `getVisionSupport()` returns `null`
  for "unknown" rather than `false`. `/props` answers for a `sleeping` model and
  502s for an `unloaded` one.
- Cache llama.cpp model props per `(model id, router status)` and store failures
  as `null` instead of retrying. A `sleeping` model answers `/props` with an
  error, and an uncached failure turns the props effect into an unbounded fetch
  and rerender loop that stalls the whole UI.
- Router SSE updates must not rebuild `routerModels` when nothing the UI renders
  changed; every event carries a fresh `raw` object, so compare rendered fields.
- New Hugging Face imports should use the stable canonical section id as the
  model id; route clients must URL-encode model ids because they may contain
  `/` and `:`.
- Show model load progress in the chat transcript, not only in the model
  selector. Loading weights takes tens of seconds; render the submitted prompt
  immediately and a `Loading weights NN%` placeholder beneath it, as llama.cpp's
  own web UI does. Router load progress arrives on `/models/sse` as
  `{"model":"<id>","data":{"status":"loading","progress":{"value":0.67}}}`; the
  model id is a top-level string, not a field inside `data`.
- Pi persists a failed turn as a contentless assistant entry (for example when
  llama.cpp answers 500 while a model loads) and then retries. Do not render
  contentless assistant entries that ran no tools; they show up as a ghost
  bubble above the real answer.
- Chat messages carry llama.cpp-style `performance.prompt` and
  `performance.generation` metrics. Pi calls go through Nelle's
  `/api/llama-proxy/v1` provider so streamed `prompt_progress` and `timings`
  chunks can update the UI and aborts can close the upstream llama.cpp fetch;
  `/slots` is only a best-effort fallback.
- Chat/regenerate/compact abort endpoints return `{aborted, warning?}`. When
  llama.cpp `/slots` still reports a processing slot after the grace window,
  surface the `llama_slot_still_processing` warning instead of killing
  llama.cpp automatically.
- Conversation snapshots derive last-known context usage from assistant
  performance metadata. Keep `prompt.totalTokens` as the full llama.cpp prompt
  total for context usage; `prompt.tokens` remains the processed-token count
  shown in the Reading stats widget.
- Assistant messages should persist the generating model id/runtime id and an
  alias snapshot. Footer model changes should regenerate through Pi-native
  branch replay with a model override, then group the new answer as a UI
  variant instead of overwriting the prior answer.
- Nelle exposes regeneration at
  `/api/conversations/:id/messages/:messageId/regenerate`, branches the Pi
  session before the original user entry, replays that user text, and stores
  `regenerates_pi_entry_id` / `display_group_id` sidecar metadata. The web UI
  preserves existing answer variants, hides replayed duplicate user turns, and
  labels visible assistant variants in the footer.
- The web UI conversation pane is collapsible and uses `@tanstack/react-virtual`
  for pinned/recent conversation sections. Keep row actions and e2e tests aligned
  when changing the sidebar.
- The sidebar collapse toggle is Astryx's `SideNavCollapseButton` in
  `footerIcons`, per their example, with `collapsible={{hasButton: false}}`. Pass
  it directly: SideNav stacks the footer row vertically when collapsed, and
  wrapping it in an `HStack` forces a row into the 48px rail and pushes the
  expand button off-screen. The toggle cannot live in the heading row, because
  `SideNavHeading` `headerEndContent` is hidden when collapsed. The collapsed
  rail carries new-chat and settings icons in `topContent`.
- Conversation rows are Astryx `SideNavItem`s with a hover/focus-revealed
  `MoreMenu` rendered as a sibling, not as `endContent`: Astryx puts `endContent`
  inside the row's own `<button>`, so a nested menu button would break semantics
  and select the chat on every menu click. Keep the menu mounted (fade it with
  opacity) so keyboard users and e2e tests can reach it.
- The slash-command allowlist lives in `packages/shared/src/commands.ts` and is
  served by `GET /api/commands`; it currently exposes only `/compact`. The chat
  route's `assertSupportedSlashCommand` and the composer render the same refusal
  through `unsupportedSlashCommandMessage`, so allowlisting a command needs no
  client release. The client prefers the fetched registry and falls back to the
  bundled one only until that request resolves. Unsupported slash commands must
  be blocked client-side with composer status guidance and must not be sent to Pi
  as prompts.
- Assistant performance metadata should render as a toggleable Reading
  (prompt processing) / Generation (token output) stats widget with icon
  controls and Astryx tooltips, not as a plain text throughput string.
- Tool calls must be correlated by stable `id` / Pi `toolCallId`; stream updates
  should upsert existing calls and preserve expandable input/output detail.
- Host tools fail closed at runtime, not only at Pi-session construction.
  `tools: []` is a build-time gate; the tool-event subscriber rechecks
  `areToolsEnabled()` and, if a tool event arrives anyway, writes no audit row,
  emits no `tool_call.updated`, pushes a `tools_disabled` error and aborts the
  run. Disabling host tools mid-run therefore makes the next tool call fail
  closed rather than killing the run outright.
- Host file/shell tools are unsandboxed in v1 and disabled until the user
  acknowledges the warning in Settings. Keep the global enable/disable switch,
  reset cached Pi sessions after changes, and persist tool audit events until
  sandboxing/per-tool permissions are designed.
- Keep the workbench viewport-bounded. Do not reintroduce document-level
  scrolling; side panels and the chat history should scroll internally while
  the composer stays docked.
- Astryx's `ChatLayout` scrolls to the bottom once on mount, inside a single
  `requestAnimationFrame`. Nelle keeps one `ChatLayout` mounted across
  conversation switches, so `useScrollChatToBottomOnOpen` re-pins the
  transcript whenever a conversation is opened, re-measuring until the height
  settles and releasing on the first wheel/touch/pointer input.
- Never leave a `backdrop-filter` covering the viewport. Astryx's `Dialog`
  frosts its `::backdrop`, and every repaint inside the dialog re-blurs the
  whole screen: measured 13fps at 3840x2160 versus 63fps without it. The
  overlay colour alone reads as a modal. Overriding StyleX needs `!important`
  (it inflates specificity with a `:not(#\#)` chain), and only the unprefixed
  `backdrop-filter` should be declared, because the CSS minifier drops it when
  `-webkit-backdrop-filter` is also written out.
- Sidebar conversation history virtualization uses `@tanstack/react-virtual`
  with an Astryx-styled `SideNav`/`List` row surface. Keep row keys stable and
  model pinned/search/group headers as one flattened virtual list.
- Composer attachments are text files, PDFs, and images only. Gate images and
  PDF-as-image mode on selected-model `modalities.vision`; do not expose
  audio/video attachments while Pi's structured input path is text plus image.
- Attachments are uploaded, not embedded. The client posts bytes to
  `POST /api/uploads`; the server classifies them, rejects a binary file posing
  as text, extracts PDF text with `pdfjs-dist`, and answers with an `uploadId`.
  A chat request carries `attachments: [{uploadId, renderPdfAsImages?}]` and
  nothing else -- `chatAttachmentReferenceSchema` is `.strict()`, so an old
  client embedding `text` or `data` is told so instead of having its bytes
  stripped. `resolveChatAttachments` expands a PDF into page images through
  `@napi-rs/canvas` at send time, which is why the per-message limits are checked
  after the expansion. Sent payloads still land content-addressed under
  `.nelle/attachments/`, with metadata bound to the Pi user entry.
- `pdfjs-dist` must not enter the web bundle again: it needs a DOM canvas, which
  React Native has not got. `tests/unit/webBundle.test.ts` fails if any file
  under `apps/web/src` imports it, or if a `pdf-*` chunk reappears in
  `dist/web/assets`.
- Draft uploads live under `.nelle/uploads/<uploadId>/` and in the `uploads`
  table, apart from the content-addressed `.nelle/attachments/` tree. An unbound
  upload older than 24h is swept at startup and hourly; a bound one belongs to a
  message and goes only with its conversation. Removing a chip in the composer
  deletes its upload rather than waiting for the sweep.
- Deleting a conversation has no confirmation dialog; it hides the row at once
  and holds the request for a 5s undo window (`utils/pendingDeletes.ts`). The
  window must be committed on `pagehide` with a `keepalive` fetch -- `sendBeacon`
  only issues POSTs -- or a reload silently cancels the deletion and the
  conversation returns from the dead. The store hides pending-deleted ids so a
  list refresh cannot resurrect them. Once the request lands it is irreversible,
  which the toast copy says.
- Conversation hard delete removes the deleted conversation's Pi session file
  and only unreferenced attachment files. Server startup also sweeps orphan
  files under `.nelle/attachments/` that are absent from SQLite attachment
  metadata. Keep file cleanup constrained to Nelle-owned data/session
  directories.
- Conversation export/import uses local `.nelle-chat.zip` archives with
  manifest checksums, the Pi session JSONL, Nelle sidecar metadata, referenced
  attachment files, model snapshots, and `tool-audit.jsonl` rows when host tools
  were used. Imports always create a new conversation.
- Show context-window usage through the Astryx `ChatComposer` header
  `ProgressBar` with tooltip token counts. Use composer top status for
  send-blocking errors and bottom status for non-blocking warnings.
- The context thresholds live in `packages/shared/src/context.ts`
  (`CONTEXT_WARNING_RATIO = 0.8`, `CONTEXT_OVERFLOW_RATIO = 1`). The server
  stamps `ConversationContextUsage.status` on every payload it emits, so a client
  picks a colour rather than recomputing a ratio. Both harnesses emit
  `context.updated` during a run through `createLiveContextTracker`, which
  throttles to one event per 250ms but never delays a threshold crossing:
  generation grows `usedTokens` by one per token, so an unthrottled tracker puts
  one event on the wire per generated token.
- `performance.updated` already carries the merged reading; both harnesses merge
  into the assistant message before emitting. Clients assign it. The
  `llamacpp-timings` beats `llamacpp-slots` precedence lives only in
  `mergeChatPerformance`.
- Pi's in-process `AgentSession.abortRetry()` returns `void`; its RPC client
  returns `Promise<void>`. `ManagedSession.session` is typed `any`, so treating
  the result as a promise compiles and then throws at runtime. Await it through
  `abortSessionRetry()`.
- Do not set `ChatComposer` `isDisabled` while a run streams or compacts. Astryx
  dims the composer to 0.6 opacity and sets `pointer-events: none` on the whole
  subtree, which makes the stop button unclickable and lets the transcript show
  through. Keep the composer enabled during runs and reject sends with a
  composer warning instead.
- The docked composer paints an opaque backdrop over Astryx's `ChatLayout` blur
  layer, and the composer scopes the alpha-based `--color-error-muted` /
  `--color-warning-muted` tokens to opaque mixes. Chat content must never be
  legible through the composer or its status bars.
- Do not pass arbitrary Pi slash commands through chat input. Nelle supports
  only its allowlist, initially `/compact [instructions]`; session, model, auth,
  settings, export, and copy flows belong to Nelle UI controls.
- `/compact [instructions]` is implemented with Pi `AgentSession.compact()`;
  compaction stop uses `AgentSession.abortCompaction()`. Do not send
  `/compact` through normal prompt submission.
- Let Astryx `ChatComposer` render its default `ChatSendButton` unless you are
  deliberately replacing it through `sendButton`; `sendActions` is only for
  auxiliary controls and must not create a second send affordance.
- Use `plans/nelle-router-chat-ui-plan.md` as the source of truth for the
  router-mode model lifecycle, `models.ini` ownership, sidebar, settings, and
  conversation UI overhaul.
- Use `plans/nelle-gap-remediation-plan.md` as the source of truth for known
  divergences between the implementation and the other two plans. Before marking
  anything there as done, re-verify it against the code; before adding a gap,
  cite the `file:line` that proves it.
- Use `plans/nelle-thin-client-plan.md` as the source of truth for what belongs
  on the server versus in a client. Nelle is growing a React Native client and a
  desktop shell, so a rule the browser owns is a rule every client reimplements.
  Before adding logic to `apps/web/src`, ask: does it need server data or CPU, or
  does it change the shape of what gets rendered? Then it belongs on the server.
  Is it a pure helper only TypeScript clients will call? Then `packages/shared`.
  Rendering, drafts, optimistic UI, scroll, and live run state stay in the
  client, as does `canAbort`/`canCompact`, which the client tracks more freshly
  than any payload can carry.

<!-- ASTRYX:START -->
Astryx v0.1.3 · 149 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   149 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
