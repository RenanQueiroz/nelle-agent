# AGENTS — apps/client

Guidance for the Flutter client (`nelle_agent`): UI rules, forui, testing and
driving the app, and the client's half of the wire contract. Repo-wide rules
live in the root `AGENTS.md`; server rules in `apps/server/AGENTS.md`.

## Client Rules

- `apps/client` architecture: Riverpod for state,
  `dio` for HTTP plus a hand-written SSE transport, `go_router` for routing, forui
  over `MaterialApp`. **API models are contract-first codegen**, not hand-written:
  `dart run tool/gen_api.dart` strips `paths` (and the `ChatStreamEvent` oneOf) from
  `openapi.json` into a models-only `openapi.models.json`, `swagger_parser`
  generates the DTOs into `lib/src/api/generated/` (committed, analyzer-excluded,
  regenerated — never hand-edit), and `build_runner` writes the `.g.dart`. Finish
  with `dart format lib/src/api/generated`: swagger_parser emits unformatted Dart,
  and any later `dart format` over the package rewrites it, so skipping the step
  leaves the committed code and the generator's output permanently disagreeing. CI's
  client job re-runs the whole chain against the committed `openapi.json` and fails
  on any diff, so a stale generated model cannot reach `main`. The
  18-variant `ChatStreamEvent` is the deliberate exception, hand-written in
  `lib/src/api/chat_stream_event.dart`: codegen mangles the discriminated `oneOf`,
  so a Dart 3 `sealed class` switches on the wire `type` (the stable contract),
  tolerating both the SSE envelope (`{type, data:<event>}`) and a raw event, with an
  `UnknownStreamEvent` so a newer server event never crashes an older client. The
  chat controller folds `message.assistant.delta`/`.reasoning_delta`,
  `model.loading`, `context.updated`, and `run.completed` into optimistic pending
  turns, then reloads the authoritative snapshot. The client never re-derives server
  truth: it reads `capabilities`, the server-stamped context `status`, and
  `reasoningLevel` off the snapshot.
- The per-conversation composer. The model selector and
  the reasoning control both write the *conversation* -- `PATCH
/api/conversations/:id {defaultModelId}` and `PUT .../reasoning` -- and apply the
  snapshot the server answers with, so two chats can sit on two models at once
  (verified: E4B and E2B resident together, each answering its own chat). Neither
  disturbs a run in flight: a snapshot describes the conversation and knows nothing
  about the reply currently streaming, so both preserve `pending`/`running`. The
  model catalog comes from `snapshot.models.available`, which exists even when
  llama.cpp is stopped -- you must still be able to choose, because the server loads
  the conversation's model when the run starts -- and llama.cpp's live router status
  is only *overlaid* on it, as a subtitle line rather than a label suffix, which the
  ellipsis would eat. Regenerate is a footer action on an assistant message, never on
  a pending one: a pending turn's id is local and the server has never seen it.
- The Flutter client's own `RouterModelEvent` parses llama.cpp's raw `/models/sse`
  (the model id is top-level, the progress is staged), and `ChatStreamEvent` parses
  Nelle's envelope. **Two different SSE shapes that must never share a parser** —
  feeding a router frame to `ChatStreamEvent.fromEnvelope` mis-parses every event.
- Markdown rendering. Models answer in markdown, so assistant
  content *and* reasoning render through **one** widget, `MarkdownMessage` — nothing
  else imports `flutter_markdown_plus` (the engine is a bet; the wrapper makes
  swapping it a one-file change). **User turns are never markdown**: someone who
  types `a * b` must see what they typed. Load-bearing details, each a bug before it
  was a rule:
  - **`softLineBreak: true`.** It defaults to `false`, and CommonMark *collapses* the
    single newlines a model writes into one paragraph — a structured answer becomes a
    wall of text.
  - **`md.CodeSyntax()` comes first in `inlineSyntaxes`.** User syntaxes are
    evaluated before the parser's own defaults (`inline_parser.dart:62`), so LaTeX
    would otherwise reach inside a code span and eat `` `${A}${B}` `` as an equation.
    Reorder this and shell breaks.
  - **`tableColumnWidth: IntrinsicColumnWidth()`.** The package wraps a table in a
    horizontal scroller *only* for a Fixed or Intrinsic width (`builder.dart:447`);
    the default `FlexColumnWidth` gets none, so a wide model table squashes its
    columns or pushes the page sideways.
  - **Raw HTML renders as literal text, and that is correct.** The package does not
    do inline HTML, and models emit `<br>` and `<details>` anyway; showing the tag
    beats silently eating content. It has a test; do not "fix" it.
  - The streaming bubble **re-parses on a throttle** (80 ms). Measured: 2.4 kB parses
    in 2.9 ms, 51 kB in 14.4 ms — against a 16.7 ms frame, with a delta per token.
    Settled messages are free (`MarkdownBody` re-parses only when `data` or
    `styleSheet` changes) — which holds *only* while the style sheet stays
    value-equal across rebuilds, so a test pins that. The throttle is a timer-only
    cooldown: do not mix a wall-clock `Stopwatch` with `Timer`, because widget tests
    fake the latter but not the former, turning runner load into test behaviour.
  - **Links are allowlisted by scheme** (`http`/`https`/`mailto`). A markdown link is
    text the model wrote: its visible text says anything, its target is what runs.
- The client renders LaTeX (gemma answers arithmetic in it), but **both halves of
  `flutter_markdown_plus_latex` are deliberately replaced**. Its inline syntax treats
  `( x )` and `[ x ]` as maths, so "the result ( see above ) is 391" parses as an
  equation; ours (`latex_syntax.dart`) keeps only the four real delimiters and guards
  `$…$` the way KaTeX does — no whitespace inside the delimiters, no digit after the
  closing `$` — so "it costs $5 and $10" and "set $HOME and $PATH" stay prose. Its
  element builder (`latex_math.dart` replaces it) wrapped *every* equation in a
  greedy horizontal scroller that ate the rest of the line around inline maths, with
  no error fallback (a malformed equation painted a red error box). Only its
  **block** syntax is used. Known limitation: text after an inline equation starts on
  a new line — flutter_markdown lays inline children out in a `Wrap`, not
  `WidgetSpan`s, so it cannot re-flow around them.
- Code blocks are highlighted with **`re_highlight`** (a Dart port of highlight.js);
  `flutter_highlight` is a dead end (it depends on discontinued `highlight.dart`).
  Highlighting is never load-bearing: an unknown language, or a block still streaming
  and half-written, falls back to the plain monospace span. The palette **follows the
  app's brightness** — the app carries a full dark theme (`app.dart:32`), and a light
  palette on a dark code block is dark-on-dark.
- Composer attachments, compaction and slash commands. Attachments are
  **uploaded, not embedded**: the bytes go to `POST /api/uploads` (multipart, carrying the
  `conversationId`) the moment a file is staged, and the chat request references
  `{uploadId}` and nothing else. The draft is **per conversation** -- an image is gated on
  the model *that chat* answers with -- and it is cleared on `run.started`, never at send:
  that one choice is what lets a refused message keep its chips as well as its text, since
  the uploads are still on the server, unbound. Removing a chip **deletes** the upload;
  `clear()` deletes nothing, because those uploads are a message now.
  - A chip shows the server's `warnings[]` and, for a PDF with no text layer, that it will
    be sent as N page **images** (~1200 context tokens each). The composer previews an
    image it just read -- free, and only there. The transcript renders **chips, not
    thumbnails**: a past message's bytes are not on the client and no route serves them.
  - **`/compact` is not refused by the chat route.** It is on the server's allowlist, so
    posting it to `chat/stream` hands the model the literal text "/compact" --
    intercepting it is the client's job. Everything else is refused client-side with the
    **server's own sentence**, from the fetched `GET /api/commands`; the bundled registry
    holds only `/compact` and exists so `/model` is still refused in the app's first
    second.
  - The "context compacted" row is **synthesized** from `compact.completed`.
    `buildConversationMessages` drops compaction entries (no role), so `snapshot.messages`
    never carries one and reloading will not make it appear. `compact.completed`'s
    `tokensBefore`/`summaryPreview`/`firstKeptEntryId` are declared and **never
    populated** -- do not build on them. Stopping prefers `runs/:runId/abort`, the only
    abort that answers with a `warning`.
  - **A non-2xx does not throw**: dio hands back the body so a `NelleError` can be read
    off it. Parsing an error body as a settings or command payload yields silent nonsense
    -- an *empty* registry says "no commands are supported" and would refuse `/compact`
    itself. Check the status before believing the body.
- LAN pairing + auth. A `ServerConnection` is *loopback*
  (`http://127.0.0.1:8787`, no token, no pin) or *paired* (`https://<lan>:8788`, a
  pinned certificate and a device bearer token). URL, pin and device id travel
  together: pointing at a new URL drops the pin and device id, or one server's
  certificate would be pinned against another server's address. Loopback stays the
  default, so a desktop install is untouched by all of this.
  - **The refresh lives in `onResponse`, not `onError`.** dio is built with
    `validateStatus: (_) => true` so callers can read `NelleError` bodies off non-2xx
    responses — which routes *every* response, 401 included, to the success path. The
    textbook `onError` interceptor is dead code here, and the symptom is not an
    exception: it is a client that silently stops being authenticated with every test
    still green. The refresh is single-flight and version-checked (see the
    token-rotation bullet in `apps/server/AGENTS.md`): a 401 for a token another
    request already replaced is *replayed*, not refreshed again.
  - **Pinning is the whole trust decision.** `badCertificateCallback` fires for any
    certificate the platform will not validate — which a self-signed one never is — so
    returning `true` unconditionally (the fix every snippet suggests) disables TLS
    entirely. It compares SHA-256 of the DER against the pin, and a mismatch is
    refused with **no way to override**; the UI says re-key-or-MITM under a red shield,
    because "Server unreachable" would send the user to check the one thing that is
    definitely not wrong. The web cannot pin at all (a browser decides before any Dart
    runs), so the adapter is conditionally imported and LAN mode is native-only.
  - The pairing details are **pasted or scanned as one blob**, never retyped field by
    field: the fingerprint is 32 bytes of hex, and it is also the entire trust
    decision. It travels out-of-band (clipboard, camera, a person reading it aloud),
    which is what makes the pin *pre-shared* rather than trust-on-first-use. The host
    offers the QR *and* the code *and* the URLs, because the code is typeable and the
    desktop-to-desktop case has no camera.
  - The client **probes every offered address**; `POST /api/pair` tells the device its
    own id, because `GET /api/devices` is loopback-only and a paired phone can never
    ask.
  - `GET /api/attachments/:id/content` serves a past message's bytes, fetched
    **through the app's dio, never `Image.network`** — which opens its own client,
    carries no bearer (401) and knows nothing of the pin (handshake failure): broken
    on exactly the device the route was added for. `storage_path` comes out of the
    database, so it is refused if it escapes the attachments tree: a row is not a
    capability to read any file on the machine.
- **Three Flutter traps the param editor walked into, each invisible to `flutter analyze`
  and to every unit test.** (1) **`Map.hashCode` is identity-based in Dart.** Keying a widget on
  `params.hashCode` so a save re-seeds it looks right and is a bug: every catalog refresh parses
  a fresh Map, mints a new key, destroys the State and eats what the user was typing. Compare
  content in `didUpdateWidget` instead. (2) **`AsyncValue.guard` swallows the exception into the
  state**, so a caller awaiting a Riverpod mutation never sees it — a refused params save then
  silently does nothing: no marked rows, no message. Rethrow. (3) **forui's `FButton` lays its
  child out in an unflexed `Row`**, so a long label overflows the button (94px here) — the same
  shape as the composer's earlier 91px overflow on Android. Keep button labels short and put the sentence
  beside them.
- **This app is forui over a bare `FScaffold`, so it has no `Material` ancestor.** A
  Material-only widget (`Switch`, `IconButton`, anything wanting an ink splash) throws
  *"No Material widget found"* and paints a red error box — while `flutter analyze`
  stays clean and every unit test passes. Use `FSwitch`, `FButton`, or a
  `GestureDetector`. The trap extends to *tests*: the older widget tests wrap their
  subject in a Material `Scaffold`, supplying an ancestor the real screen does not
  have. Host a screen in `FScaffold` if that is what it runs in.
  - **An icon button is a ghost `FButton.icon`, not a raw `GestureDetector`.** Every
    small tappable glyph is `FButton.icon(variant: FButtonVariant.ghost, size:
    FButtonSizeVariant.xs)` (`.sm` where it sits level with a 36px field). Ghost
    stays flat until hover, so the look is unchanged at rest while press/hover/focus
    feedback and semantics come for free. Two things to keep: pass the glyph's real
    `size`/`color` on the child `Icon` (it overrides the button's icon theme — xs
    defaults to 14px in a 24×24 square, sm to 16px in 32×32), and a `null` `onPress`
    is how an end-of-range arrow disables itself. A raw `GestureDetector` is the
    fallback only for a **non-button** tap target — a text link or a whole structural
    row.
- **When working with any forui widget, read forui's own AI docs first — do not guess
  its API from memory.** The index is **https://forui.dev/docs/llms.txt**; it links a
  machine-readable **https://forui.dev/docs/llms-full.txt** and per-component pages
  (`https://forui.dev/docs/widgets/<group>/<name>.md`). forui moves fast and its
  constructors, style deltas and control objects (`FSelectControl`,
  `FPopoverController`, `FAccordion`, `context.theme.colors.*`) are easy to get
  subtly wrong — fetch the relevant `.md` and match the current signature. Muted
  footer text uses `context.theme.colors.mutedForeground`; the bright body uses
  `foreground`.
- Clipboard and drag-and-drop use **`pasteboard`** and **`desktop_drop`** (plain
  platform-channel plugins, both maintained). **Do not reach for `super_clipboard` /
  `super_drag_and_drop`**, the obvious choice and a dead end: they pull in
  `super_native_extensions` -> `irondash_engine_context` -> **cargokit**, whose
  Gradle plugin calls `Project.exec()` — removed in Gradle 9, which this project is
  on (9.1.0 / AGP 9.0.1). `flutter build apk` dies, cargokit is archived, and no
  patch is coming; a fork would mean owning an abandoned Rust-backed native library
  across five platforms. The paste path: an image (`Pasteboard.image`), else a *file*
  (`Pasteboard.files`), else text — a picture or a file is an attachment; only text
  belongs in the message.
- **Secure storage needs a keyring, and Linux may not have one.**
  `flutter_secure_storage` needs `libsecret` *plus* something answering
  `org.freedesktop.secrets` (gnome-keyring, KWallet, KeePassXC); a bare window manager
  has none. The token store must report *unavailable* rather than throw: loopback
  keeps working with no keyring at all (it is unauthenticated — that is the point),
  and only remote pairing is refused, with a sentence saying why.
  Android/iOS/macOS/Windows are unaffected (Keystore/Keychain/credential store are
  OS-provided).
- **A phone is not a narrow desktop, and the difference finds bugs.** Ten minutes on Android
  found a composer that overflowed by 91px (an unflexed `Row` a 1280px window had always been
  wide enough to hide) and a conversation list that never reloaded after pairing (the notifier
  `read` its repository instead of watching it — invisible on a desktop, where loopback works
  *before* you pair, and the first thing that happens on a phone, where it cannot). Widget
  tests must pin the phone size (`tester.view.physicalSize`) to see either.
- The Flutter client is instrumented for **agent-driven UI testing**: `lib/main.dart`
  initializes `MarionetteBinding` **only under `kDebugMode`** (release keeps the
  plain `WidgetsFlutterBinding`), and the repo's MCP config registers `marionette`
  (drives the running app) and the official `dart` server (runtime errors, widget
  tree, analyze).
- **A client change is not done until it has been driven in the running app.**
  `flutter analyze` + `flutter test` green is necessary and not sufficient: 36
  passing tests did not catch a refused message silently eating the user's typed
  text, and one minute of driving did. Drive the real flow, look at screenshots,
  check runtime errors, and deliberately drive the edges — empty states, error
  states, refusals, aborts, layout breaks — where client bugs live and no unit test
  looks. Any bug found this way gets a regression test before the fix is committed.
  Give every interactive widget a stable `ValueKey`; Marionette matches by key or
  visible text, and raw coordinates silently rot. The workflow, edge checklist and
  the Linux/WSL2 platform quirks (emulator flags, phone networking, WSLg clipboard,
  drive keyring) are in the `driving-the-client` skill
  (`.agents/skills/driving-the-client/SKILL.md`).
- **Two testing tools, and they are not alternatives.** **Marionette is
  exploratory** — the agent drives the running app while iterating, which is how the
  bugs above get found. **`integration_test` is the regression tool** — it *pins*
  what driving discovered. A bug found by driving becomes a device test; a device
  test is never how you explore. The device suite runs the **real** app against a
  **real Nelle server** fixture, in two tiers: **`bun run test:device`** (fast,
  ~7 min, llama.cpp stopped — what a fresh install is, and where most error paths
  live) and **`bun run test:device:slow`** (~2 min, on demand, a real gemma-4-E2B
  generating). The same fast tier runs on the Android emulator
  (`bun run test:device -- -d emulator-5554`); run it on both, because the phone
  finds what the desktop hides — and **assert the claim, not a proxy visible on a
  1280px window** ("the original is unchanged" is a fact about the server, so ask
  the server). Before writing, running or debugging a device test, read the
  `device-tests` skill (`.agents/skills/device-tests/SKILL.md`): its harness traps
  (`pumpAndSettle` races, silent `enterText` no-ops, off-screen taps, read-only
  fixtures, hand-seeded Pi sessions) have each cost a debugging session.
- **The macOS app needs `com.apple.security.network.client`; Flutter's template does
  not give it to you.** The macOS App Sandbox blocks every outbound connection without
  it — the app builds, launches, and fails every request with `SocketException:
  Connection failed (OS Error: Operation not permitted, errno = 1)`. Nobody noticed
  because macOS had never been built or run; CI failed 14 of 15 device tests on its
  first attempt and found it. Both `macos/Runner/{Debug,Release}.entitlements` carry
  it now.
- **The macOS app also needs `com.apple.security.files.user-selected.read-write`, or
  the attach / import / export file dialogs silently do nothing.** `file_selector`'s
  open/save panels run in Apple's out-of-process **powerbox**, which only grants
  access to the chosen file when this entitlement is present — without it every picker
  **no-ops with no error at all**. `read-write`, not `read-only`, because Export
  (`getSaveLocation`) *writes* the archive. Entitlements bake in at build/sign time —
  a hot reload will not pick them up; rebuild. To verify a sandboxed picker opened
  without TCC grants: clicking it spawns
  `com.apple.appkit.xpc.openAndSavePanelService` (`ps -ax | grep openAndSave`), which
  exists only while a panel is up.
- **A lazy `ListView` never builds a row that is far off-screen, so *waiting* for it
  cannot work.** `tapAt` used to `pumpUntil` first, sitting 15s for a widget nothing
  would ever build; it **scrolls first** now (`scrollUntilVisible`), then waits.
  Invisible on a tall desktop window where the list fits; fatal on a phone, on
  Windows, and on any shorter window — 14 of 15 tests passed on Windows and the one
  reaching for the Models section below the fold timed out.
- **`libsecret-1-dev` is a *build* dependency of the Linux client, not an optional one.**
  `flutter_secure_storage_linux` fails CMake outright without it, which is how the Linux device job
  failed on its first CI run. That is a different thing from the **runtime** keyring (something
  answering `org.freedesktop.secrets`), which genuinely is optional — loopback is unauthenticated by
  design and needs none.
- A client uses Nelle's `/api/llama/*` router facade for llama.cpp props, models,
  load/unload, reload, model props, and router events. Nothing talks to llama.cpp
  directly: it is Nelle's child process, on a port Nelle chose, and only Nelle knows
  whether it is up and which of its models it configured.
- Runtime settings should show router-reported loaded/maximum model capacity
  from `/api/llama/props`; let llama.cpp enforce model scheduling.
- The composer's reasoning selector reads `canReason` as a tri-state, preferring
  live props and falling back to `snapshot.capabilities.canReason`. llama.cpp
  answers `/props` only for a model it has loaded at least once, so `null` means
  "not known yet" and must stay editable; only a template that provably has no
  thinking mode (`false`) locks the control to `off`.
- A settings draft is what the user is typing, so only the save that made it
  stale may overwrite it. A catalog or snapshot refresh must never re-seed drafts:
  it may add and drop whole models, but it may not rewrite a field the user has a
  cursor in (the Flutter param editor's `Map.hashCode` trap above is this bug in
  another shape). Seed once on load; each save resets from the values the server
  answered with.
- Conversation search is a server query, never a filter over the loaded page.
  The sidebar holds a window onto the list, so filtering it client-side reports
  "no matching chats" for every conversation the user has not scrolled to.
  Section headers and any chat count must render `total`, not the number of rows
  paged in.
- The composer model selector is compact but router-aware: it is searchable,
  groups the user's favourites first, shows selected/row router
  status/progress from router SSE updates, and loads unloaded router models
  before activating them. Its row rendering and filter/sort live in
  `models/model_picker.dart`, shared with the assistant footer's model dropdown so the
  two lists cannot drift.
- **"llama.cpp is stopped" and "not in the list we hold" are different things, and
  conflating them is a bug that has now been made twice.** The server *seeds* every
  configured section into `GET /api/llama/models`, so a configured model missing from a
  client's cached list means that list is simply older than the import -- not that the
  runtime is down. Saying "llama.cpp stopped" there told a freshly imported model the
  runtime was off while it was plainly running, *and* -- because the Load button was gated
  on the same check -- left the one model you had just added as the one model you could not
  load. The Flutter client's `routerStatusLabel` is the single rule (`listed == null` ->
  stopped; `router == null` -> not listed yet; else llama.cpp's own free-form word), and
  Load is gated on llama.cpp being **up**, never on the model being in the list.
- Settings rows for models with active runs must show an active-run token and
  keep unload/save/remove disabled until a terminal run event arrives.
- **The run lock is the client's, and it is keyed by conversation.** A model with a run
  streaming on it must not be unloaded (that evicts the weights the answer is being generated
  from), have its params saved (that rewrites `models.ini` and reloads the router under the run)
  or be removed. The server does not police this and should not: a live run is the one piece of
  state a client tracks more freshly than any payload can carry. The Flutter client's
  `activeRunsProvider` maps **conversationId -> modelId**, never a bare set of model ids: two
  conversations can be answered by one model at once -- that is what `runtime.modelsMax >= 2` is
  *for* -- and a set would be cleared by whichever run finished first, unlocking a model that is
  still generating. It is claimed when the run *starts* (the model is loaded before `run.started`
  is emitted, and unloading it during that window is just as fatal) and released in the single
  terminal path, which every ending goes through. Renaming, activating and duplicating stay
  available: they are `models.ini` bookkeeping and never reach the running model. A disabled
  button with no explanation is a bug report, so the screen says why.
- Chat run state is conversation-scoped. Use per-conversation run-kind
  state and abort controllers, keep inactive stream deltas out of the visible
  transcript, and allow a ready conversation to send while another conversation
  is still running.
- A conversation with a run in flight shows a spinner *and* status text in the
  sidebar, not only a status dot, so a user can spot a running agent after
  switching chats.
- Cache llama.cpp model props per `(model id, router status)` and store failures
  as `null` instead of retrying. A `sleeping` model answers `/props` with an
  error, and an uncached failure turns the props effect into an unbounded fetch
  and rerender loop that stalls the whole UI.
- Router SSE updates must not rebuild `routerModels` when nothing the UI renders
  changed; every event carries a fresh `raw` object, so compare rendered fields.
- Show model load progress in the chat transcript, not only in the model
  selector. Loading weights takes tens of seconds; render the submitted prompt
  immediately and a `Loading weights NN%` placeholder beneath it, as llama.cpp's
  own web UI does. Router load progress arrives on `/models/sse` as
  `{"model":"<id>","event":"status_change","data":{"status":"loading","progress":
{"stages":["text_model","mmproj_model"],"current":"text_model","value":0.77}}}`;
  the model id is a top-level string, not a field inside `data`.
- A client's router SSE subscription must **reattach on its own**. Stopping
  llama.cpp *ends* the stream rather than failing it, so a client that only
  handles `onError` never learns it went deaf: every model status it shows
  freezes at whatever it last saw, for the rest of the session, while llama.cpp
  restarts behind it. Reattach on both `onError` and `onDone`, backing off, and
  re-list on reconnect -- a restarted llama.cpp may hold a different set of
  models.
- Pi persists a failed turn as a contentless assistant entry (for example when
  llama.cpp answers 500 while a model loads) and then retries. Do not render
  contentless assistant entries that ran no tools; they show up as a ghost
  bubble above the real answer.
- **The assistant footer's model indicator is a dropdown** (`MessageModelDropdown`) —
  picking a model **both** repins the conversation default (`setModel` ->
  `PATCH .../defaultModelId`) **and** regenerates *this* message with it as an
  override (`regenerate(messageId, modelId:)`; repin first, then the explicit
  override so the re-answer is deterministic). The old answer survives as a labelled
  variant — the server's doing. **It is the *same component* as the composer
  selector**: both are `ModelPickerSelect` (`models/model_picker.dart`) — same
  `FSelect` trigger, favourites-first search, hover-reactive rows, `ModelStatusLine`
  and `ModelFavoriteStar` (a per-surface `keyPrefix` keeps keys from colliding). They
  differ only in width, the value shown, and what a pick does — do not fork them back
  into two lists (a custom `FPopover` + hand-rolled rows was the first attempt and
  was wrong: the trigger looked off and the rows didn't react to hover). `chat_view`
  injects it **only when regenerating is allowed** (`canRegenerate`); during a run or
  on a pending turn `MessageBubble` shows the alias as plain text. No server change
  was needed — the regenerate endpoint has taken `{modelId}` since the web client.
- **The message footer follows llama.cpp's hierarchy and reflow.** The body is a step
  larger (`_messageBodyStyle`, 15.5px) and the assistant answer is **plain text
  flush-left** (no bubble) so it lines up with the footer; the user turn keeps its
  right-aligned chip. The footer is de-emphasised —
  `context.theme.colors.mutedForeground`, one shared token for every footer element —
  with larger items (badges 16/14, action icons 18) so they read next to the model
  dropdown.
- **`FooterBar` lays a group of sections in a row with a `•` separator when they fit,
  and stacks them without separators when they don't** (`chat/footer_bar.dart`, a
  small custom `MultiChildRenderObjectWidget` in the shape of Material's
  `OverflowBar` plus a painted bullet; a `Wrap` can't do this because a childed
  separator survives the wrap). The assistant footer is **two** stacked row-groups —
  **`[model dropdown • generation-metrics]`** then **`[variant switcher • actions]`**
  — so a wide window is 2 rows and a phone is 3; the user footer is one group,
  **`[reading-metrics • actions]`**. `RenderFooterBar.isRow` is exposed for tests,
  which pin the wide (row + `•`) and phone (stacked) cases. Actions are **copy**
  (both roles; `Clipboard.setData` + toast) then regenerate (assistant) / fork
  (user).
- **Reasoning and tool calls render as expandable cards** through one shared
  `ExpandableCard` (`chat/expandable_card.dart` = forui `FCard.raw` + `FAccordion`;
  the *only* place the accordion engine lives, like `MarkdownMessage` for markdown).
  It insets the accordion horizontally — `FCard.raw` adds no padding and
  `FAccordion`'s title/child padding is vertical-only. **Tool-call rendering is
  folded client-side**: the chat controller upserts `tool_call.updated` into
  `ChatState.liveToolCalls` by id (running → complete/error), reset per run and
  cleared by the snapshot reload; `chat_view` passes the live run's calls for a
  streaming assistant and the settled `message.toolCalls` (`parseToolCalls`) for a
  finished one. Each is a `ToolCallCard` above the answer: a status icon + the tool
  name, expanding to monospace Input/Output. Tool calls only appear when **host tools
  are enabled** (off by default).
- Performance metadata renders as **per-message stat rows**, matching llama.cpp's current web
  UI (there is no toggle -- an earlier design had a switchable Reading/Generation widget; it is
  gone): prompt-processing stats (`⟨ab⟩ tokens · ⟨clock⟩ time · ⟨gauge⟩ tokens/s`) beneath the
  **user** turn, generation stats (`… t/s`) in the **assistant** footer beside the model alias.
  Each datapoint is an icon+value badge whose field name shows on hover/long-press (`FTooltip`,
  never Material `Tooltip`). The reading row's data lives on the *assistant* message (or the live
  run), so the transcript pairs each visible assistant with its preceding user turn; the row uses
  the **visible** regenerate variant. Rates are **derived from tokens ÷ ms**, never read from
  llama.cpp's rate fields, and shown *only when the burst was long enough to time* (`PerfMetric`
  in `chat/performance_stats.dart`; a `79 tokens / 0.003ms` frame yields no rate). Live values
  come from folding `performance.updated` into `ChatState.livePerformance` (per generated token);
  settled values from each message's own `performance`, with a fallback to the legacy
  `generatedTokens`/`tokensPerSecond` for messages persisted before the metric objects. The whole
  feature is gated on the served `showGenerationStats` **display** preference (default on) --
  `displaySettingsProvider` is the first client consumer of a `display` pref.
- Tool calls must be correlated by stable `id` / Pi `toolCallId`; stream updates
  should upsert existing calls and preserve expandable input/output detail.
- Keep the workbench viewport-bounded: the sidebar and the chat history scroll
  internally while the composer stays docked. Opening a conversation pins the
  transcript to its newest message, re-measuring until the height settles and
  releasing on the user's first scroll input.
- Composer attachments are text files, PDFs, and images only. Gate images on
  selected-model `modalities.vision`; do not expose audio/video attachments while
  Pi's structured input path is text plus image.
- The attachment drawer renders only when something is attached.
- A message the server refused before it became a turn (no `run.started`) must
  leave the composer draft intact. The uploads are still on the server, unbound,
  and making the user retype the prompt and pick the files again is not a fix.
- **The conversation lifecycle UI.** Search, pin, rename, fork, clone, export,
  import, repair, rebuild, diagnostics.
  - **Export cannot save a file on a phone**, and this is what the packages
    implement, not a preference: `file_selector_android` has only `openFile`,
    `openFiles` and `getDirectoryPath`; `getSaveLocation` exists on desktop/web and
    nowhere else, and `getDirectoryPath` is no way round it (a SAF content URI
    `dart:io` cannot write to). So `ArchiveService` splits — a Save dialog on
    desktop, the **OS share sheet** (`share_plus`) on mobile. Import is uniform
    (`openFiles`). `share_plus` is plain platform channels — not the
    `super_clipboard` trap.
  - **`POST /api/conversations/import` is NOT multipart**, unlike `/api/uploads`: it
    reads the zip straight off `ctx.req.arrayBuffer()`, so a multipart envelope gets
    `invalid_archive_upload`. And **export answers bytes while a *failed* export
    answers JSON** — dio needs `ResponseType.bytes` up front, so decode the error
    body (`sendBytes`) or the user gets "Request failed" for a refusal the server
    explained in a sentence. The archive's filename comes off `content-disposition`;
    the server already slugged it.
  - **Fork and clone are different acts in different places.** A **fork** branches at
    one of the *user's* messages (a transcript footer action, gated on
    `capabilities.canFork`) — regenerate is what belongs on the model's answer. A
    **clone** duplicates the whole conversation (a sidebar action, no `entryId`).
    Both refuse the impossible with **`conversation_not_branchable`** and a 409 (an
    empty conversation has a header-only Pi session and nothing to branch from; both
    used to be a bare 500). A branched conversation must *say* so (`forkKind`) — a
    fork's transcript looks like a chat that begins mid-thought, and the user needs
    to know the original still exists.
  - **`archive_session_missing` is a distinct refusal, not "your file is corrupt".**
    Exporting an `unavailable` conversation is allowed on purpose (you must be able
    to salvage a broken chat; the manifest records `piSessionMissing`); importing it
    is refused, but the zip is perfectly *valid* — it simply carries no history.
  - **Delete is held, not undone.** The server's delete is irreversible the moment it
    lands (the Pi session file, and every attachment nothing else references), so the
    request is simply not *sent* for five seconds while the row is hidden — hidden
    from a refresh too, or a list reload inside the window resurrects it. No
    confirmation dialog: it taxes ninety-nine deliberate deletes to catch the one
    mistake the undo catches for free. The undo copy says the landing is
    irreversible.
  - **The unavailable conversation is not an empty one.** The Pi session JSONL *is*
    the history; SQLite holds a projection. Rendering a broken chat as an ordinary
    empty chat with a working composer told the user their conversation was gone when
    it was recoverable. Three explicit exits: **repair** (lossless, offered first —
    it only succeeds if the user put the file back, because it never invents a
    session), **rebuild** (lossy, and the UI must *name* what it destroys: tool
    results, image content, compaction summaries, regenerate variants), and delete.
    The reason line is the filesystem's own, from `GET /diagnostics`. A repair or
    rebuild must also **refresh the sidebar**: the list row carries `status` and does
    not re-fetch on its own.
  - **Search is a server query**, and the loaded page is a window onto the list —
    filtering it client-side reports "no matching chats" for every conversation the
    user has not scrolled to. The query rides into `loadMore`, or page two pages the
    results out of their own query. Debounced *and* token-guarded: a debounce narrows
    the race without closing it, and a slow early answer landing last leaves the box
    saying one thing and the list showing another.
- **A dialog must own its `TextEditingController`.** `showFDialog(...).whenComplete(
  controller.dispose)` is the obvious spelling and it **crashes the app to a red screen**: the
  future completes when `Navigator.pop` is called, while the dialog is still *animating out*, and
  its `FTextField` keeps rebuilding against the controller. "A TextEditingController was used
  after being disposed." `flutter analyze` is clean and every widget test passes -- a test only
  sees it if it `pumpAndSettle`s past the exit animation. Put the controller in a `State`, whose
  `dispose()` runs when the element is actually unmounted.
- Show context-window usage in the composer header, as a progress bar with the
  used/total token counts behind it. Send-blocking errors belong above the
  composer, non-blocking warnings below it.
- The composer stays disabled until there is an active conversation. The id is
  empty until the conversation list resolves, and a message sent then had nowhere
  to go: the submit handler returned early and the typed text was lost.
- **Never disable the composer while a run streams or compacts** -- the stop button
  lives inside it, so disabling the composer disables the only way to stop the run.
  Keep it enabled during runs and reject a send with a composer warning instead.
- The docked composer must be opaque: chat content must never be legible through
  it or through its status bars.
- Do not pass arbitrary Pi slash commands through chat input. Nelle supports
  only its allowlist, initially `/compact [instructions]`; session, model, auth,
  settings, export, and copy flows belong to Nelle UI controls.
- The composer has exactly **one** send affordance. Auxiliary controls (attach,
  model, reasoning) never grow into a second one.
- **Seven groups, one renderer, and it must stay that way.** `instructions`,
  `attachments`, `titles`, `reasoning`, `display`, `runtime`, `network` all render
  from `GET /api/settings/schema` with **no client code that knows what any of them
  mean** — labels, help, bounds, options and defaults all arrive from the server, so
  a new setting ships without a client release. The moment a client special-cases
  `maxImageMegapixels`, the schema has been thrown away.
- **`SettingsSection`/`SettingsField` is a *rendering* contract, not "the server's
  data".** The client describes its **device-local** sections (Appearance;
  Notifications when it lands) with the *same types* and draws them with the *same
  widget*, behind a `SettingsSource` (`ServerSettingsSource` over HTTP,
  `DeviceSettingsSource` over SharedPreferences). A setting is device-local when
  applying it to another device would be wrong or impossible: `System` theme resolves
  against *that* OS, a notification permission is per device, and the server
  connection *is* this device's relationship to a server. Everything else follows
  the user. If a device setting ever needs its own UI, the renderer is wrong.
- **A refused save keeps the draft and names the field.** `PATCH
  /api/settings/<slug>` is `.strict()` and zod-validated, and the refusal carries the
  offending key in `error.detail` — the client shows the server's own sentence
  *under that control*, not at the bottom of a nine-field form. Only touched fields
  are sent: a save must not rewrite a value the user never looked at.
- A paste longer than `attachments.pasteToFileCharacters` (default 2,500; `0`
  disables) becomes a `.txt` upload instead of forty thousand characters in the
  input. The client owns the event because only it has one; the threshold and the
  ingestion are the server's, and until `GET /api/settings/attachments` answers,
  the client has no threshold and every paste stays in the message -- it must not
  carry a copy of the default.
- Settings a client *acts* on are the **saved values**, never the drafts: a
  half-typed threshold is not in force until it is saved.
- **The generated title streams *after* `run.completed`, so a client must not cancel
  the chat stream when the answer's run ends.** `streamConversationTitleIfNeeded`
  runs as its own short **title sub-run** on the *same* SSE stream, emitting
  `conversation.updated {title, titleSource:'generated'}` before `queue.end()` —
  blocking `run.completed` on it would leave the composer "running" for the ~1-2s the
  title takes. The client trap: the Flutter controller used to cancel the
  subscription on `run.completed`, dropping the trailing title event — a fresh chat
  sat at "New chat" in the sidebar for the whole session. It now keeps the stream
  open on a clean finish (`_watchingForTitle`), folds `conversation.updated` into a
  live `ChatState.titleOverride` **and** the sidebar
  (`ConversationsNotifier.applyGeneratedTitle`, fallback-rows-only, mirroring the
  server's `setGeneratedTitle`), and ignores the title sub-run's own `run.*` frames —
  the sidebar list is loaded once and only mutated by explicit actions, so nothing
  else would ever have applied the title to it. A failed run or a compaction sends no
  title and is cancelled at once.
