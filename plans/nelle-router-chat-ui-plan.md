# Nelle Router And Chat UI Plan

Last updated: 2026-07-08

## Goal

Move Nelle from the current proof-of-concept workbench to a router-first chat
application that uses llama.cpp's router mode as the runtime source of truth.
The target shape is closer to llama.cpp's built-in UI and ChatGPT:

1. `llama-server` always runs in router mode with `--models-preset`.
2. `.nelle/llama/models.ini` is the model catalog and parameter source of
   truth.
3. Nelle initially supports only Hugging Face GGUF references through
   `hf-repo`/`-hf`; local file paths are deferred.
4. Selecting a model can load it, show progress/status, and rely on the router
   to enforce `models-max` and unload least-recently-used models.
5. The app moves to conversation-centric chat with a collapsible sidebar,
   searchable virtualized conversation list, conversation actions, and settings.

## Upstream Findings

Snapshot inspected: `ggml-org/llama.cpp` master commit `bec4772`.

Relevant upstream behavior:

- Router mode is active when `llama-server` starts without a single model and
  uses `--models-preset <ini>`.
- `GET /props` returns router metadata when no `model` query is supplied:
  `role = "router"`, `max_instances`, and `models_autoload`.
- `GET /models` in router mode returns all known models plus status metadata.
  Each entry includes `id`, `aliases`, `source`, `can_remove`, `architecture`,
  and `status.value`.
- Router status values are `unloaded`, `loading`, `loaded`, `sleeping`, and
  `failed`.
- `POST /models/load` accepts `{ "model": "<id>", "extra_args"?: [...] }`.
  It returns before loading completes; the UI waits for `/models/sse`.
- `POST /models/unload` accepts `{ "model": "<id>" }`.
- `GET /models/sse` emits status/progress events such as `model_status`,
  `status_change`, `status_update`, `models_reload`, `model_remove`, and
  `download_progress`.
- The router backend enforces `models_max` itself. Before loading a model it
  calls `unload_lru()`, and a second locked capacity check prevents concurrent
  loads from exceeding the configured limit.
- `GET /models?reload=1` makes the router reload model sources and unload
  models whose source entry was removed or changed.
- llama.cpp also has `POST /models`, but that path validates/downloads a HF
  model into the router cache. Nelle should not use it for normal imports while
  `models.ini` is the single source of truth.

Relevant upstream UI patterns:

- On app layout mount, llama.cpp fetches router models and subscribes to
  `/models/sse` when `role = "router"`.
- The model selector displays loaded/loading state, search, favorites, and load
  progress. If a selected model is not loaded, it calls `loadModel`.
- The selector and store do not implement custom `models_max` policy; the
  backend router does.
- Assistant messages persist the model that generated them and display that
  model in the assistant footer.
- llama.cpp's assistant footer uses the router model selector as a per-message
  regenerate control. Choosing a different model loads it if needed and calls
  regenerate with a `modelOverride`.
- llama.cpp displays performance metrics through a compact statistics widget
  with icon-only view toggles for `Reading` and `Generation`, plus icon/value
  metric badges with tooltips.
- Regeneration is branch-based in llama.cpp: it creates a sibling assistant
  message from the same parent user message rather than overwriting the old
  answer.
- Copy is implemented as a message action that formats the message and writes it
  to the clipboard.
- The sidebar supports collapse/expand, new chat, settings, search, pinned
  conversations, recent conversations, per-item overflow actions, and running
  generation indicators.
- Conversation item actions include pin/unpin, edit name, export, delete, and
  stop generation when that conversation is streaming.

## Current Gaps

Nelle currently differs from the target in these ways:

- App state owns `models[]` and `activeModelId`; `models.ini` is generated from
  app state instead of being the source.
- Presets are still generated from app state instead of edited as durable
  structured INI.
- Runtime settings for `modelsMax` and `sleepIdleSeconds` exist, but the final
  settings surface is not built yet.
- The web UI has side panels for runtime/model setup rather than a durable
  conversation sidebar plus settings.
- Chat storage is one global `chat` array, not multiple conversations.
- Reset conversation is a composer footer action rather than a conversation
  action.
- Model import/edit UX is split between app state and generated preset writes.

## Target Data Ownership

### `models.ini`

`models.ini` becomes the durable model catalog. Nelle should parse, edit, and
write this file through structured INI operations.

Minimum shape:

```ini
version = 1

[*]
c = 8192

[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]
hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
alias = Qwen 35B Q4 XL
stop-timeout = 10
```

Rules:

- Only HF-backed model sections are supported in this phase.
- Every user-imported model section must include `hf-repo`.
- `alias` is the user-facing display label in Nelle's model dropdown.
- Section names stay llama.cpp/OpenAI model ids. They should be stable and
  compatible with llama.cpp canonicalization.
- The `[*]` section stores global llama.cpp parameters.
- Model sections store per-model overrides.
- Nelle should avoid silently writing flags not configured by the user.
- Preserve unknown keys so advanced users can keep manually edited options.
- The UI should expose key/value editing for global and per-model params, with
  lightweight validation for duplicate keys, empty keys, and dangerous section
  names.

### App Database

Move durable app state to SQLite before, or as part of, the sidebar work. The
conversation UI depends on querying, filtering, exporting, and updating many
conversation records.

Core tables:

- `conversations`: `id`, `title`, `pinned`, `created_at`, `updated_at`,
  `model_id`, `archived_at?`.
- `messages`: `id`, `conversation_id`, `role`, `content`, `created_at`,
  `parent_id`, `active_child_id?`, `model_id?`, `model_runtime_id?`,
  `model_alias_snapshot?`, `performance_json`, `tool_calls_json`.
- `settings`: runtime and UI settings that are not model params.

Message model fields:

- `model_id` is Nelle's configured model/section id used to request the answer.
- `model_runtime_id` is the llama.cpp/OpenAI model id observed in the request or
  stream, such as the canonical quant-tag id.
- `model_alias_snapshot` is the display label at generation time. It keeps old
  messages understandable even if the user later renames or removes the model.
- For Pi responses, set these fields from the active/override model at stream
  start and update from llama.cpp stream metadata if the proxy observes a more
  specific runtime id.

Keep generated files out of the DB:

- `.nelle/llama/models.ini`
- `.nelle/llama/llama-server.pid.json`
- logs, downloads, llama.cpp binaries/builds

## Router Runtime Architecture

### Launch

Always launch router mode:

```bash
llama-server \
  --host <host> \
  --port <port> \
  --models-preset <data-dir>/llama/models.ini \
  --models-max <configured max> \
  --sleep-idle-seconds <configured seconds>
```

Changes from current behavior:

- Remove the requirement for an active model before start. The router can start
  with zero or many model sections.
- Stop writing a one-model preset during start.
- Stop forcing `--models-max 1`. Store `modelsMax` as a user setting and pass it
  through. Default remains `1`.
- Pass `--sleep-idle-seconds` from user settings. Default is `90`.
- Changing `modelsMax` or `sleepIdleSeconds` requires a `llama-server` restart.
- Keep managed pid adoption logic.

### Runtime API Facade

Nelle should expose stable local APIs that wrap llama.cpp router endpoints:

- `GET /api/llama/props`
  - calls router `/props`
  - returns `role`, `maxInstances`, `modelsAutoload`, runtime status
- `GET /api/llama/models`
  - calls router `/models`
  - merges model metadata with parsed `models.ini` display aliases and params
- `POST /api/llama/models/:id/load`
  - calls router `/models/load`
  - returns immediately plus current status
- `POST /api/llama/models/:id/unload`
  - calls router `/models/unload`
- `GET /api/llama/models/events`
  - server-sent event bridge for router `/models/sse`
- `POST /api/llama/models/reload`
  - calls router `GET /models?reload=1`
- `PUT /api/llama/models-ini`
  - writes global and model-section params, then reloads if running

Nelle's UI should not call llama.cpp directly except through the existing chat
proxy path. This gives us one place to normalize errors, router-offline states,
and future auth/pairing.

### Model Loading

Selection behavior:

1. User selects a model by section id/model id.
2. If router reports `loaded` or `sleeping`, use it immediately.
3. If router reports `unloaded`, call Nelle load API.
4. Subscribe to model SSE status and show progress until `loaded`.
5. If loading fails, keep the previous selection and surface the router status
   and logs link.

Capacity behavior:

- Let llama.cpp enforce `models-max`.
- Do not try to pre-unload models in the UI.
- When `models-max` is reached, router `load()` attempts LRU unloading. If the
  locked capacity check still fails, surface the error and refresh model status.
- Display current `max_instances` from `/props` so users understand why a model
  was unloaded.

## Model Management UX

Move model import and editing into Settings.

Settings sections:

- Runtime
  - install/update llama.cpp
  - start/stop router
  - host/port
  - `models-max`
  - `sleep-idle-seconds`
  - easy access to llama-server logs/status
- Models
  - search Hugging Face GGUF repos/quants
  - import selected HF ref into `models.ini`
  - edit display alias
  - edit model-section key/value params
  - duplicate/remove model sections
  - load/unload actions with live status
- Global llama.cpp params
  - edit `[*]` key/value params
- Chats
  - clear all chats
  - export/import conversations

HF import:

1. Search HF for GGUF repos and quants as today.
2. User selects repo and quant.
3. Nelle adds/updates a section in `models.ini`:
   - section id: canonical llama.cpp runtime id if known, otherwise deterministic
     sanitized id based on repo plus quant
   - `hf-repo = <repo>:<quant>`
   - `alias = <user alias or repo:quant>`
4. If router is running, call reload.
5. The model appears in the selector as unloaded until the user selects/load it.

Local file path support:

- Remove UI and API for local GGUF path registration immediately.
- Keep the plan open for later local-file support by representing it as a future
  `model = <path>` or other llama.cpp preset key in `models.ini`, not as direct
  Nelle-owned model downloads.

## Chat And Conversation UX

### Layout

Target first screen:

- Collapsible left sidebar.
- Main chat area with message history and docked composer.
- Model selector in the composer/header showing alias plus router status.
- Settings opens as a route or modal panel, not as always-visible side columns.

Sidebar:

- Top actions: new chat, search, settings, collapse/expand.
- Search bar filters conversations by title.
- Virtualized conversation list.
- Pinned group first, then recent/search results.
- Each item shows title, active state, optional streaming indicator, and overflow
  menu.

Conversation item menu:

- Pin/unpin.
- Rename.
- Export.
- Delete.
- Future: duplicate/fork.

Composer:

- Remove reset conversation button from composer footer.
- Keep model dropdown.
- Keep exactly one Astryx default send/stop button.

### Assistant Message Footer

Each assistant message footer should show:

- Timestamp.
- Model picker/dropdown displaying the model that generated that answer.
- Toggleable performance statistics when available.
- Copy button.
- Regenerate button.

Use Astryx `ChatMessageMetadata.footer` as a React node instead of a formatted
string. The footer should remain compact, wrap cleanly on narrow widths, and use
icon buttons with accessible labels/tooltips for copy and regenerate.

### Performance Statistics View

Replace the current plain `prompt 32.30 tok/s · gen 21.53 tok/s` footer text
with a compact statistics widget modeled after llama.cpp's
`ChatMessageStatistics`.

Views:

- `Reading`: prompt processing.
- `Generation`: token output.

View toggles:

- Use icon-only controls rather than visible text labels.
- Use a book/read icon for `Reading (prompt processing)`.
- Use a sparkle/output icon for `Generation (token output)`.
- Each toggle must have an accessible label and Astryx `Tooltip` content.
- During live streaming, default to `Reading` while prompt processing is active,
  then switch to `Generation` once generated tokens arrive.
- Disable the `Generation` toggle while a live message has no generated tokens
  yet.

Reading metrics:

- Prompt tokens.
- Prompt processing time.
- Prompt processing speed.

Generation metrics:

- Generated tokens.
- Generation time.
- Generation speed.

Metric display:

- Use icon/value badges or compact inline items.
- Prefer lucide icons through the existing React icon stack:
  - token count: `WholeWord` or equivalent token/word icon
  - time: `Clock`
  - speed: `Gauge`
- Wrap each metric item in Astryx `Tooltip` with the exact label, such as
  `Prompt tokens`, `Prompt processing time`, `Prompt processing speed`,
  `Generated tokens`, `Generation time`, and `Generation speed`.
- Keep visible strings short, e.g. `1,024 tokens`, `1.24s`, `32.30 t/s`.
- Metric items may be clickable later for copy-to-clipboard parity with
  llama.cpp, but that is optional for the first Nelle pass.

Data mapping:

- `performance.prompt.tokens` -> prompt tokens.
- `performance.prompt.milliseconds` -> prompt processing time.
- `performance.prompt.tokensPerSecond` -> prompt processing speed.
- `performance.generation.tokens` -> generated tokens.
- `performance.generation.milliseconds` -> generation time.
- `performance.generation.tokensPerSecond` -> generation speed.
- Prefer exact streamed llama.cpp `prompt_progress` and final/streamed
  `timings` values from Nelle's llama proxy. `/slots` data remains a fallback
  and should not overwrite exact streamed timings.

Astryx implementation direction:

- Use `Tooltip` from `@astryxdesign/core/Tooltip` for hover/focus explanations.
- Use stable, fixed-size icon buttons/badges so switching between Reading and
  Generation does not shift the surrounding footer layout.
- Keep the widget inside `ChatMessageMetadata.footer` alongside the message
  model dropdown, copy, and regenerate controls.
- Avoid raw color/spacing values; use Astryx tokens or component props.

Model dropdown behavior:

1. The dropdown's current value is the message's `model_id`/`model_runtime_id`,
   displayed using `model_alias_snapshot` or the current alias from
   `models.ini`.
2. Opening the dropdown lists router models with the same loaded/loading/failed
   status used by the composer selector.
3. Selecting the same model triggers a normal regenerate.
4. Selecting a different model loads that model through the router if needed,
   then regenerates that assistant message with `modelOverride`.
5. The per-message dropdown does not change the composer/global selected model
   unless we deliberately add that behavior later.
6. If the historical model is no longer in `models.ini`, show the snapshot label
   as unavailable and keep copy/regenerate with another selected model possible.

Copy behavior:

- Copy the assistant message content as plain text/markdown text.
- Do not include tool-call internals by default; add explicit copy controls for
  tool details later if needed.
- Use the browser Clipboard API with a fallback for non-secure contexts, and
  surface success/failure through a compact notice.

Regenerate behavior:

- Add a conversation-scoped regenerate endpoint:
  `POST /api/conversations/:conversationId/messages/:messageId/regenerate`.
- Request body: `{ "modelId"?: string }`.
- The server finds the parent user message and the active path up to that parent,
  creates a sibling assistant branch, and streams the new assistant answer.
- The previous assistant answer is not hard-deleted. The conversation active
  path moves to the regenerated branch.
- Store model metadata, timings, and tool calls on the newly generated message.
- If model loading fails, keep the old active branch and surface the router
  error/log link.

### Virtualized List

Use real virtualization for conversation rows once conversation count can grow.
Decision:

- Astryx v0.1.3 provides `SideNav`, `List`, chat scroll containers, and
  infinite-message loading primitives, but does not expose a clean reusable
  virtual list/listbox for arbitrary sidebar rows.
- Use Astryx for the visual shell, row styling, tokens, menus, and tooltips.
- Use `@tanstack/react-virtual` for sidebar conversation virtualization.

Constraints:

- Build one flattened row model with section rows and conversation rows instead
  of nested virtualizers.
- `useVirtualizer` should target the sidebar scroll element owned by the
  `SideNav`/sidebar content region.
- Provide stable `getItemKey` values such as `section:pinned` and
  `conversation:<conversation_id>` so search, pinning, deletion, and prepended
  rows do not reuse DOM state incorrectly.
- Start with fixed estimated row heights and measure only if row content needs
  dynamic height later.
- Use a small overscan buffer, roughly 8-12 rows, to keep wheel/trackpad
  scrolling smooth without mounting the full history.
- Keep active-conversation navigation working with `scrollToIndex` when search
  or routing activates a row outside the visible range.
- Pinned and unpinned groups should be modeled as section rows in the flattened
  list.
- Search results should virtualize too.
- Keyboard focus and overflow menus must remain stable when rows mount/unmount.
- Overflow menus and tooltips should use portal/top-layer behavior when
  available, so a menu opened from a virtual row is not clipped by the scroll
  container or unexpectedly tied to row-local layout state.

### Conversation Persistence

API shape:

- `GET /api/conversations?search=&cursor=&limit=`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `PATCH /api/conversations/:id`
- `DELETE /api/conversations/:id`
- `POST /api/conversations/:id/pin`
- `POST /api/conversations/:id/export`
- `DELETE /api/conversations`
- `POST /api/conversations/:id/chat/stream`
- `POST /api/conversations/:id/messages/:messageId/regenerate`

Chat streaming should be conversation-scoped. The stream route appends the user
message, streams assistant deltas/tool calls/timing metadata, persists the final
assistant message, records model metadata, and updates
`conversations.updated_at`.

## Generated Conversation Titles

Requirement:

- After the model finishes the assistant response to the first user prompt in a
  conversation, send a separate title-generation prompt.
- The title prompt must not be persisted in the conversation history.
- The generated title becomes the conversation title unless the user has already
  renamed the conversation.

Proposed title prompt:

```text
Create a concise title for this conversation.
Return only the title.
Limit it to 6 words.
No quotes, punctuation suffix, markdown, or explanation.

User: <first user prompt>
Assistant: <first assistant response>
```

Implementation notes:

- Use the same active model after the first response completes.
- Use direct llama.cpp chat-completions through Nelle's llama proxy, not Pi,
  because title generation should not invoke tools or alter Pi session state.
- Set a small `max_tokens` such as 24.
- Strip quotes/newlines, cap length, and fall back to a truncated user prompt if
  title generation fails.
- Do not trigger title generation for imported conversations or conversations
  with a user-edited title.

## Migration Plan

Existing POC state may contain `.nelle/state.json` with `models[]`,
`activeModelId`, and one global `chat`.

Migration steps:

1. Parse existing `models[]`.
2. Write HF-backed models into `models.ini` if not already present.
3. Drop local path models from active state; keep `state.json` as backup for
   manual recovery if needed.
4. Convert global `chat` into a single conversation if non-empty.
5. Preserve the selected model as the default new-chat model if its section
   exists in `models.ini`.
6. Keep `state.json` as a backup until SQLite migration is proven.

## Implementation Phases

### Phase 1: Router Metadata And `models.ini` Ownership

- Add a structured `models.ini` parser/writer module.
- Change `LlamaCppManager.start()` to start router mode without requiring an
  active model.
- Add configurable `modelsMax` and `sleepIdleSeconds`.
- Remove local path registration UI/API from the active product surface.
- Make HF import write `models.ini` sections directly.
- Add `/api/llama/models`, reload, load, unload, and events endpoints.
- Update Pi model generation to read from parsed `models.ini`.

Exit criteria:

- Start router with zero or more configured HF models.
- Importing an HF quant updates `models.ini`.
- Running router reloads model list without restarting.
- Selecting an unloaded model loads it through router endpoints.
- Router-enforced `models-max` is reflected in UI status.

### Phase 2: Model Selector And Settings

- Build settings surface with Runtime, Models, Global Params, and Chats sections.
- Move HF search/import and param editing into Settings.
- Replace composer model dropdown with router-aware selector:
  alias display, search, status, load progress.
- Add manual load/unload controls in Settings model rows.

Exit criteria:

- Users can edit global/model params without editing files.
- Users can see loaded/loading/unloaded/failed states.
- Model selector loads on selection and shows progress.

### Phase 3: Conversations And Sidebar

- Add SQLite conversation/message storage.
- Replace global chat state with conversation-scoped APIs.
- Add message parent/branch metadata so regenerated answers can become siblings
  rather than destructive replacements.
- Add collapsible sidebar with new chat, settings, search, virtualized list, and
  item overflow menus.
- Move reset/delete behavior to sidebar actions.
- Add conversation export/delete/pin/rename.

Exit criteria:

- Multiple conversations persist and can be searched.
- Large conversation lists do not cause sidebar lag.
- Active conversation can stream while another conversation is visible in the
  list with a running indicator.
- Regenerated assistant messages create a new active branch without deleting the
  previous answer.

### Phase 3B: Assistant Footer Actions

- Persist `model_id`, `model_runtime_id`, and `model_alias_snapshot` on
  assistant messages.
- Replace the metadata footer string with a composed footer row containing
  timestamp, model dropdown, performance statistics, copy, and regenerate.
- Replace the old throughput text with a Reading/Generation statistics widget
  that shows tokens, elapsed time, and speed for the active view.
- Add model override regeneration through the router-aware selector.
- Add clipboard copy behavior for assistant messages.

Exit criteria:

- Every assistant message shows the model that generated it.
- Selecting a different model from an assistant footer loads that model if
  needed and regenerates the answer in one action.
- Copy writes the assistant text to the clipboard and gives visible feedback.
- Timing metrics render as a toggleable Reading/Generation widget with icon
  controls and tooltips, without layout overflow on mobile or desktop widths.

### Phase 4: Title Generation

- Add non-persisted title-generation request after first response.
- Add safeguards for user-edited/imported titles.
- Add tests for success, failure fallback, and no-history pollution.

Exit criteria:

- New conversations receive concise generated titles after first response.
- The title prompt is never persisted or sent through Pi tools.

## Testing Strategy

Unit tests:

- `models.ini` parse/write, including unknown key preservation.
- HF import section generation.
- Global and per-model param validation.
- Router event normalization.
- Conversation title sanitization/fallback.
- Message model metadata selection and alias snapshot fallback.
- Regenerate request path construction, branch creation, and model override
  validation.
- Performance statistics view selection, formatting, and live auto-switching.
- Clipboard text formatting.
- Sidebar row flattening, stable virtual keys, and search/pinned grouping.

Integration tests:

- Mock router endpoints for `/props`, `/models`, `/models/load`,
  `/models/unload`, `/models/sse`.
- Verify selector calls load and updates status from SSE.
- Verify `models-max` is displayed from `/props`.
- Verify editing `models.ini` calls reload when router is running.
- Verify regenerate with a model override calls router load when needed and
  streams with the selected model.
- Verify regenerate preserves the old assistant answer as a sibling branch.
- Verify prompt/generation metric mapping from streamed `prompt_progress` and
  `timings`.

Playwright tests:

- Settings HF import writes `models.ini` and model appears in selector.
- Selecting an unloaded model shows loading progress then selected loaded model.
- Sidebar creates, searches, pins, renames, exports, and deletes conversations.
- Composer stays docked while message list scrolls.
- Virtualized list remains responsive with thousands of conversations and keeps
  the mounted sidebar row count bounded.
- Virtualized sidebar overflow menus, keyboard focus, and active-row scrolling
  keep working after large scroll jumps.
- Assistant footer shows timestamp, model label/dropdown, Reading/Generation
  statistics, copy, and regenerate.
- Statistics toggles switch between prompt tokens/time/speed and generated
  tokens/time/speed.
- Statistics icons expose hover/focus tooltip text for every metric.
- Selecting a different footer model regenerates with that model and keeps the
  new model label on the regenerated answer.
- Copy button writes assistant text to the clipboard.
- Title generation updates only the conversation title, not message history.

## Risks And Decisions

- `models.ini` round-trip: we need a structured writer that does not destroy
  unknown user params. Avoid ad hoc string edits.
- Model id canonicalization: llama.cpp may expose a canonical id different from
  the HF quant suffix. We need stable section ids and alias display rules.
- Historical model display: message footers must keep a model alias snapshot so
  renamed or removed models do not make old answers ambiguous.
- Regeneration semantics: branch-based regeneration avoids destructive loss, but
  it requires active-path handling and UI affordances for sibling navigation.
- Running router reload: changing or removing a loaded section can trigger
  unload. The UI must warn before destructive model edits.
- Local path migration: local path model entries are removed from active state,
  so backup state should remain available until the SQLite migration is proven.
- SQLite timing: sidebar and virtualized conversation list are awkward on the
  current single-array JSON state. Doing SQLite first reduces rework.
- Title generation cost: it adds one extra model call on new conversations.
  Keep it short and make failures silent.

## Settled Follow-Up Decisions

- `modelsMax` defaults to `1`, is user-configurable, and requires a
  `llama-server` restart.
- `sleepIdleSeconds` defaults to `90`, is user-configurable, and requires a
  `llama-server` restart.
- Model/global parameter editing starts as free-form key/value UI only. Invalid
  parameters should fail through llama-server, and Nelle exposes the
  llama-server log tail for diagnosis.
- Do not expose llama.cpp's cache-sourced `POST /models` import path for normal
  Nelle imports; `models.ini` stays authoritative.
- Conversation delete is a hard delete for now.
- Local file model APIs are removed now, not just hidden.
