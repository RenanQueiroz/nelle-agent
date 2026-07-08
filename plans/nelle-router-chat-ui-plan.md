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
- In router mode, llama.cpp UI treats global `/props` as server/router metadata
  and fetches `/props?model=<id>&autoload=false` for loaded model-specific
  metadata such as modalities and `default_generation_settings.n_ctx`.
- Model modalities are exposed as booleans for `vision`, `audio`, and `video`.
  Nelle will use `vision` for image gating and ignore audio/video in the first
  attachment pass because Pi's supported structured input path is text plus
  images.
- Text files and PDFs are always accepted. PDFs are sent as extracted text by
  default, or as page images only when the selected model has vision support and
  the user enables that mode.
- Images require vision support. Unknown or binary-looking files should be
  rejected or skipped with a visible composer status.
- llama.cpp's chat stream supports `return_progress`; streamed
  `prompt_progress` contains `total`, `cache`, `processed`, and `time_ms`.
  Final/streamed `timings` carries prompt and generated-token timing data.
- llama.cpp reports context-overflow errors with `n_prompt_tokens` and `n_ctx`,
  and exposes `n_ctx` in `/props` and `/slots`.

Relevant Pi slash-command behavior:

- Pi's interactive editor opens command completion when the user types `/`.
  Built-in commands include model/session/auth/settings/history utilities plus
  `/compact [prompt]`.
- Pi also exposes extension commands, skill commands, and prompt-template
  commands through the same slash-command namespace.
- Manual compaction is the only Pi built-in slash command Nelle should support
  directly in the chat composer at first. It is conversation scoped and accepts
  optional custom instructions.
- Pi auto-compaction triggers when context exceeds its configured threshold, and
  manual `/compact [instructions]` summarizes older messages while preserving
  recent context.
- The installed Pi SDK docs say `session.prompt()` handles prompt templates,
  extension commands, and message sending. Pi's built-in interactive commands
  such as `/compact` are handled by interactive-mode code, so the Nelle
  implementation must verify the correct SDK/RPC/manual compaction hook before
  assuming that `session.prompt("/compact")` works.
- Astryx's `ChatComposerInputSlashCommands` template uses
  `ChatComposerInput` `triggers`, `createStaticSource`, and `TypeaheadItem` to
  provide a slash-command typeahead. Nelle should reuse that pattern with its
  own command allowlist and descriptions.

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
- The composer has no attachment drawer, file picker, context-window bar, or
  model-modality gating.
- Chat warnings/errors still appear as page-level notices instead of
  composer-local Astryx status messages.
- The composer has no slash-command typeahead, and manual Pi compaction has no
  Nelle-owned visual feedback.

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
- `message_attachments`: `id`, `message_id`, `kind`, `name`, `mime_type`,
  `size_bytes`, `storage_path?`, `text_content?`, `processing_json`,
  `created_at`.
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
- attachment binary payloads under `.nelle/attachments/` when they are too
  large or unsuitable for SQLite rows

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
- `GET /api/llama/models/:id/props`
  - calls router `/props?model=<id>&autoload=false`
  - returns model-specific `modalities`, `n_ctx`, chat template, and fetch state
  - may return `unavailable` for unloaded models without autoloading them
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
- `POST /api/llama/tokenize`
  - optional helper for text-only draft estimates
  - should never be treated as authoritative for multimodal requests or full
    chat-template/tool history

Nelle's UI should not call llama.cpp directly except through the existing chat
proxy path. This gives us one place to normalize errors, router-offline states,
and future auth/pairing.

### Model Loading

Selection behavior:

1. User selects a model by section id/model id.
2. If router reports `loaded` or `sleeping`, use it immediately.
3. If router reports `unloaded`, call Nelle load API.
4. Subscribe to model SSE status and show progress until `loaded`.
5. Fetch `/api/llama/models/:id/props` once loaded so the UI can cache
   modalities and context size for that model.
6. If loading fails, keep the previous selection and surface the router status
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
- Add a paperclip attachment action in `headerActions`.
- Show context-window usage in `headerContext`.
- Add slash-command typeahead for Nelle-supported chat commands.
- Route chat-blocking errors and chat warnings through Astryx `ChatComposer`
  status instead of page-level notices.

### Composer Attachments, Context, And Status

Use Astryx's full-featured composer pattern:

- `ChatComposerDrawer` holds attachment chips/previews.
- `Token` represents attached files with remove controls.
- `headerActions` contains the attach-file button and later any context-source
  controls.
- `headerContext` contains a compact `ProgressBar` for context-window usage.
- `footerActions` keeps the router-aware model selector and settings controls.
- `sendActions` remains for auxiliary controls only. Do not add another send
  button.

Attachment support:

- Start with user-selected local files from the browser file picker, drag/drop,
  and paste when browser APIs support it.
- Supported attachment kinds are text files, PDFs, and images. Audio and video
  attachments are out of scope for this phase.
- Voice capture remains out of scope.
- Use browser-side file processing for preview and immediate send:
  - read text files as UTF-8 and reject empty/binary-looking content;
  - extract PDF text with `pdfjs-dist`;
  - optionally render PDF pages to PNG data URLs when the selected model has
    vision support and the user enables PDF-as-image mode;
  - normalize image formats to model-friendly data URLs where needed.
- Persist attachment metadata with the message. Store large binary payloads
  under `.nelle/attachments/` and keep the DB row as metadata plus relative
  storage pointer.

Modality gating:

- Source of truth is model-specific props from
  `/api/llama/models/:id/props`, which wraps
  `/props?model=<id>&autoload=false`.
- In router mode, unloaded models may not have props. After selection loads the
  model, refresh props before enabling model-specific attachment controls.
- If modalities are unknown, allow only text and PDF-as-text; keep image
  controls disabled with a tooltip/status explaining that the selected model
  needs to be loaded before capabilities are known.
- Text files and PDF-as-text are model-agnostic.
- Images and PDF-as-image require `modalities.vision`.
- Keep `modalities.audio` and `modalities.video` in the internal model-props
  type for parity with llama.cpp responses, but do not expose audio/video upload
  in the Nelle composer while Pi only supports text and image structured input.
- If the user switches models with pending attachments, revalidate the pending
  attachment list against the new model and surface any newly unsupported items
  as a top composer error until removed or converted.
- When replaying conversation history for a model without vision, strip
  unsupported image parts from history and surface a warning rather than sending
  invalid content.

Pi and llama.cpp payload mapping:

- Change the Nelle chat request model from `prompt: string` to a structured
  content array: text parts plus normalized image attachment parts.
- For llama.cpp/OpenAI chat completions:
  - text/PDF content becomes `type: "text"` content parts;
  - images/PDF pages become `type: "image_url"` parts.
- For Pi:
  - advertise `input: ["text", "image"]` for vision-capable models in the
    generated Pi model registry;
  - send text plus image content through Pi's structured user-message path
    instead of flattening images into text.
- If Pi cannot handle the selected structured content path, the composer should
  show a top error. Do not silently drop attachments or fall back to plain text.

Context-window display:

- Show an Astryx `ProgressBar` in the composer `headerContext`.
- The progress bar total is selected-model `n_ctx` from
  `/api/llama/models/:id/props`, falling back to global `/props` only outside
  router mode.
- Authoritative used-token values come from streamed `prompt_progress.total`
  during prompt processing and final/streamed `timings.prompt_n` plus cache and
  generated-token counters when available.
- The bar should update live during prompt processing and generation, then keep
  the last known usage for the active conversation.
- A debounced text-only `/api/llama/tokenize` estimate may be used for draft
  text/PDF content, but it must be marked internally as estimated and replaced
  by streamed llama.cpp values as soon as they arrive.
- The visible UI is just the progress bar. Wrap it in Astryx `Tooltip` with
  exact numbers when available, e.g. `Context: 6,240 / 32,768 tokens`.
- Use semantic progress variants:
  - neutral/accent below 80%;
  - warning at or above 80%;
  - error at or above 100% or when llama.cpp returns context overflow.
- Near-full context warnings should render as bottom composer status.
- Context overflow and send-blocking errors should render as top composer
  status.

Composer status routing:

- Use `ChatComposer` `statusPosition="top"` for blocking errors:
  llama-server stopped, no model selected, model load failed, unsupported
  attachment, attachment parse failure that prevents sending, context overflow,
  and Pi/provider structured-content gaps.
- Use default bottom status for non-blocking warnings: context near full,
  PDF-as-image disabled/fallback to text, image history stripped after model
  switch, skipped empty text files, and partial attachment conversion fallback.
- General runtime/setup notices outside the chat workflow may still appear in
  settings/log surfaces, but chat sendability should be explained at the
  composer itself.

### Slash Commands And Manual Compaction

Nelle should not pass arbitrary Pi slash commands through the chat input. The
chat composer owns a Nelle allowlist and should intercept slash commands before
normal prompt submission.

Supported initially:

- `/compact [instructions]`: manually compact the active conversation/Pi
  session. Optional instructions should focus the generated summary and should
  be visible in the command-status details.

UI-owned or unsupported initially:

- `/new`: use the sidebar new-chat button.
- `/resume`: use the conversation sidebar and search.
- `/model` and `/scoped-models`: use Nelle's router-aware model selectors.
- `/login` and `/logout`: use future Settings auth/provider flows. Nelle's
  local llama.cpp provider remains app-managed.
- `/settings`: use Nelle Settings.
- `/name`, `/session`, `/tree`, `/fork`, `/clone`, `/export`, `/import`, and
  `/share`: use Nelle's conversation sidebar, branching, export/import, and
  sharing flows as those features are implemented.
- `/copy`: use the assistant message copy button.
- `/trust`, `/reload`, `/hotkeys`, `/changelog`, and `/quit`: keep out of the
  chat composer unless Nelle implements explicit equivalents later.
- Pi extension commands, skill commands, and prompt-template commands: disabled
  or hidden by default until Nelle has a per-command allowlist and security
  model. They share the same namespace and can bypass the product boundaries we
  are building in the web UI.

Slash-command UI:

- Use the Astryx `ChatComposerInput` trigger pattern from
  `ChatComposerInputSlashCommands`: `character: "/"`, a static/searchable
  command source, `TypeaheadItem` descriptions, and token insertion through
  `onSelect`.
- Autocomplete should show only commands Nelle supports now. For the first
  implementation that means `/compact`.
- Add a command help surface, likely available from the typeahead empty state or
  a settings/help link, that explains unsupported Pi commands and the Nelle UI
  control that replaces each one.
- If a user manually submits an unsupported slash command, do not send it to
  Pi. Show a top composer error with the Nelle-owned alternative, such as "Use
  the model selector to change models."
- If the user submits an unknown slash command, show a top composer error and
  keep the draft in the composer.

`/compact` behavior:

1. Parse `/compact` and optional trailing instructions client-side or
   server-side before normal chat submission.
2. Require the active conversation to be idle for the first implementation.
   Reject while an assistant turn or another compaction is running and surface a
   composer top error.
3. Call a conversation-scoped Nelle endpoint:
   `POST /api/conversations/:id/compact`.
4. The server invokes Pi compaction for the active conversation/session.
5. Render a command/status row in the chat timeline with states such as
   pending, compacting, completed, and failed. This row should not be stored as
   a normal user or assistant message.
6. On completion, refresh context-window usage and conversation/session
   metadata. If Pi exposes compaction details such as tokens before, first kept
   entry, or summary metadata, store them in the command row details.
7. On failure, keep conversation history unchanged and show both the failed
   status row and a composer top error.

Implementation spike:

- Verify whether the embedded Pi SDK exposes a direct manual compaction API for
  a session, whether RPC mode exposes one, or whether Nelle must call lower
  level Pi compaction/session helpers. Do not rely on
  `session.prompt("/compact")` unless a spike proves that built-in slash
  commands are handled correctly outside Pi's interactive mode.

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
- `POST /api/conversations/:id/compact`
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
- Fetch and cache loaded model props so model selectors can display modality and
  context-window metadata.

Exit criteria:

- Users can edit global/model params without editing files.
- Users can see loaded/loading/unloaded/failed states.
- Model selector loads on selection and shows progress.
- Loaded models expose context size and image-support capability in the UI.

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

### Phase 3C: Composer Attachments And Context Usage

- Add structured chat content and message attachment persistence.
- Add Astryx `ChatComposerDrawer` attachment chips/previews.
- Add file picker, drag/drop, and paste handling for text, PDF, and image files.
- Add PDF text extraction and optional PDF-as-image conversion for vision
  models.
- Gate image attachments and PDF-as-image mode on selected-model vision
  support from `/api/llama/models/:id/props`.
- Add composer `ProgressBar` for context-window usage with tooltip token
  counts.
- Route chat send errors/warnings through `ChatComposer` status top/bottom
  positions.

Exit criteria:

- Text and PDF-as-text attachments work with text-only models.
- Image attachments and PDF-as-image are enabled only for vision-capable models.
- Audio/video attachments are not exposed.
- Switching models revalidates pending attachments.
- The composer shows a live/last-known context progress bar with token-count
  tooltip.
- llama-server stopped and other send-blocking conditions appear as top
  composer errors.
- Near-full context and non-blocking attachment conversions appear as bottom
  composer warnings.

### Phase 3D: Slash Commands And Manual Compaction

- Add an Astryx `ChatComposerInput` slash-command trigger backed by Nelle's
  command allowlist.
- Support `/compact [instructions]` for the active conversation.
- Add the conversation-scoped compaction API and Pi bridge adapter.
- Add command/status rows for compaction progress, completion, and failure.
- Reject unsupported Pi slash commands with composer errors that point to the
  Nelle UI equivalent.
- Add a small command help surface that describes supported commands and
  explains why UI-owned Pi commands are not forwarded.

Exit criteria:

- Typing `/` opens an Astryx-styled command typeahead showing `/compact`.
- `/compact` and `/compact <instructions>` run manual compaction for the active
  idle conversation and display visible progress.
- Unsupported commands such as `/new`, `/resume`, `/model`, `/login`, and
  `/logout` are never sent to Pi as prompts and show actionable UI guidance.
- Compaction updates the context-window display after completion.
- Pi SDK/RPC/manual compaction integration is verified by an automated or
  documented spike before relying on it in product code.

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
- Attachment file classification, modality gating, PDF/text extraction
  fallback, and context-progress formatting.
- Slash-command parsing, Nelle allowlist/blocklist behavior, unsupported
  command guidance, and `/compact` instruction extraction.

Integration tests:

- Mock router endpoints for `/props`, `/models`, `/models/load`,
  `/models/unload`, `/models/sse`.
- Mock per-model `/props?model=<id>&autoload=false` for context size and
  modalities.
- Verify selector calls load and updates status from SSE.
- Verify `models-max` is displayed from `/props`.
- Verify editing `models.ini` calls reload when router is running.
- Verify regenerate with a model override calls router load when needed and
  streams with the selected model.
- Verify regenerate preserves the old assistant answer as a sibling branch.
- Verify prompt/generation metric mapping from streamed `prompt_progress` and
  `timings`.
- Verify structured text/image content is preserved through Pi when the model
  supports image input, and rejected through composer status when it does not.
- Verify context overflow errors with `n_prompt_tokens`/`n_ctx` become composer
  top errors.
- Verify `/compact` calls the Pi compaction adapter for the active conversation,
  unsupported slash commands are rejected before Pi prompt submission, and busy
  conversations reject compaction with composer status.

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
- Attachment drawer adds/removes text, PDF, and image files; unsupported images
  are blocked for text-only models.
- Context progress bar tooltip shows used/total token counts and warning/error
  status at the configured thresholds.
- Composer shows llama-server stopped/no model/unsupported attachment as top
  status errors and near-full context as a bottom status warning.
- Typing `/` shows the slash-command typeahead, selecting `/compact` inserts the
  command token/draft, and submitting it renders compaction progress.
- Typing unsupported commands such as `/model` or `/new` shows composer guidance
  and does not append a normal chat message.
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
- Attachment token estimates: text-only `/tokenize` estimates are useful for
  draft UI but not authoritative for multimodal prompts or full chat history.
  Streamed `prompt_progress` and final `timings` remain authoritative.
- Title generation cost: it adds one extra model call on new conversations.
  Keep it short and make failures silent.
- Pi slash-command boundary: Pi owns many interactive commands that conflict
  with Nelle's UI-owned model/session/auth/settings flows. Keep the chat
  allowlist narrow, support `/compact` first, and do not expose extension, skill,
  or prompt-template slash commands until Nelle has explicit command-level
  policy.
- Pi compaction integration: built-in interactive `/compact` is not guaranteed
  to work through the same SDK path as normal prompts. Verify the correct
  embedded API/RPC/helper path before implementation.

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
- Composer attachments are text, PDF, and image only for now. Audio/video are
  excluded while the Pi integration path is text plus image.
- Only `/compact [instructions]` is supported as a Pi slash command in Nelle's
  chat composer initially. All other Pi built-ins are either handled through
  Nelle UI surfaces or intentionally unsupported until explicitly allowlisted.
