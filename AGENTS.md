# AGENTS

Project-specific guidance for AI coding agents.

## Project Rules

- Keep documentation current with every repository change. Update `README.md`
  and `AGENTS.md` whenever implementation behavior, setup commands, architecture,
  or workflow expectations change. Anything under `plans/` is local scratch
  (git-ignored) — never a shared source of truth, and never cited from committed
  docs or code.
- `AGENTS.md` is the single source of truth for shared agent guidance. Root
  `CLAUDE.md` should contain only `@AGENTS.md`.
- The server, tests, and toolchain run on **Bun** (`engines.bun`, ≥1.3); there
  is no npm/Node runtime dependency. Use `bun install`, `bun run <script>`, and
  `bun test`.
- **Nelle is an API server, and `apps/client` is its client.** The React web app
  (`apps/web`) is gone, and with it Vite, Astryx, Zustand, the Playwright suite, the
  `dist/web` static handler and `GET /api/state`. The server serves **no files**: an
  unmatched path is a coded JSON 404 (`not_found`), never an `index.html`, because
  every client is a native one that speaks the served REST + SSE contract
  (`GET /api/openapi.json`) and a typo'd endpoint answering a web page hides the
  mistake. `apps/server` is the server (its `contracts/` folder is the wire contract and the pure
  helpers over it, and is the TypeScript the server shares
  with itself, `apps/client` is the UI. Nothing else.
- `apps/client` is the Dart/Flutter client (package `nelle_agent`, bundle id
  `com.renanqueiroz.nelle_agent`) — the desktop + mobile UI, and the only client
  there is. It is *not* part of the Bun toolchain: Oxfmt, Oxlint, and `tsc`
  each ignore `apps/client` (via their own ignore lists), and Flutter's `build/`
  and `.dart_tool/` are git-ignored, so `bun run test` never touches Dart —
  removing that insulation makes `format:check` fail on Flutter's generated
  JSON/YAML. The Flutter SDK is a native install kept outside the repo (Homebrew's
  `flutter` is a macOS-only cask, so it cannot install on Linux); developed
  against Flutter 3.44 / Dart 3.12, verified with `flutter doctor`. The client
  speaks only the served REST + SSE contract (`GET /api/openapi.json`) and never
  imports server TypeScript — that boundary is what lets the
  server change its internals without breaking a shipped app. Run it with
  `flutter run -d <chrome|linux>`; build Android with `flutter build apk`.
- `apps/client` architecture (Milestone 1: loopback chat MVP): Riverpod for state,
  `dio` for HTTP plus a hand-written SSE transport, `go_router` for routing, forui
  over `MaterialApp`. **API models are contract-first codegen**, not hand-written:
  `dart run tool/gen_api.dart` strips `paths` (and the `ChatStreamEvent` oneOf) from
  `openapi.json` into a models-only `openapi.models.json`, `swagger_parser`
  generates the DTOs into `lib/src/api/generated/` (committed, analyzer-excluded,
  regenerated — never hand-edit), and `build_runner` writes the `.g.dart`. Finish
  with `dart format lib/src/api/generated`: swagger_parser emits unformatted Dart,
  and any later `dart format` over the package rewrites it, so skipping the step
  leaves the committed code and the generator's output permanently disagreeing. The
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
- `apps/client` (Milestone 2: the per-conversation composer). The model selector and
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
- `apps/client` (Milestone 3: markdown). Models answer in markdown, so assistant
  content *and* reasoning render through **one** widget, `MarkdownMessage` — nothing
  else imports `flutter_markdown_plus`. The engine is a bet (Google discontinued
  `flutter_markdown`; every option is a successor), and the wrapper is what makes
  swapping it a one-file change. **User turns are never markdown**: someone who types
  `a * b` must see what they typed. Load-bearing details, each of which was a bug
  before it was a rule:
  - **`softLineBreak: true`.** It defaults to `false`, and CommonMark *collapses* the
    single newlines a model writes into one paragraph — the difference between a
    structured answer and a wall of text.
  - **`md.CodeSyntax()` comes first in `inlineSyntaxes`.** The parser evaluates user
    syntaxes before its own defaults (*"User specified syntaxes are the first syntaxes
    to be evaluated"*, `inline_parser.dart:62`), so LaTeX would otherwise reach inside a
    code span and eat `` `${A}${B}` `` as an equation. Reorder this and shell breaks.
  - **`tableColumnWidth: IntrinsicColumnWidth()`.** The package wraps a table in a
    horizontal scroller *only* for a Fixed or Intrinsic width (`builder.dart:447`); its
    default `FlexColumnWidth` gets none, so a wide model table squashes its columns or
    pushes the page sideways.
  - **Raw HTML renders as literal text, and that is correct.** The package does not do
    inline HTML (*"Flutter isn't an HTML renderer like a web browser"*), and models emit
    `<br>` and `<details>` anyway. Showing the tag beats silently eating content the
    model meant to send. It has a test; do not "fix" it.
  - The streaming bubble **re-parses on a throttle** (80 ms). Measured: a 2.4 kB answer
    costs 2.9 ms to parse, 12 kB costs 5.3 ms, 51 kB costs 14.4 ms — against a 16.7 ms
    frame, with a delta per token. Settled messages are free (`MarkdownBody` re-parses
    only when `data` or `styleSheet` changes, `widget.dart:366`) — which holds *only*
    while the style sheet stays value-equal across rebuilds, so a test pins that.
  - **Links are allowlisted by scheme** (`http`/`https`/`mailto`). A markdown link is
    text the model wrote: its visible text says anything, its target is what runs.
- The Flutter client renders LaTeX because gemma answers arithmetic in it, but **both
  halves of `flutter_markdown_plus_latex` are deliberately replaced**. Its inline syntax
  treats `( x )` and `[ x ]` as maths, so "the result ( see above ) is 391" parses as an
  equation; ours (`latex_syntax.dart`) keeps only the four real delimiters and guards
  `$…$` the way KaTeX does — no whitespace inside the delimiters, no digit after the
  closing `$` — so "it costs $5 and $10" and "set $HOME and $PATH" stay prose. Its
  element builder (`latex_math.dart` replaces it) wrapped *every* equation in a greedy
  horizontal scroller, which ate the rest of the line around inline maths, and had no
  error fallback, so a malformed equation painted a red error box instead of the text the
  model wrote. Only its **block** syntax is used. Known limitation: text after an inline
  equation starts on a new line — flutter_markdown lays inline children out in a `Wrap`,
  not `WidgetSpan`s, so it cannot re-flow around them.
- Code blocks are highlighted with **`re_highlight`** (a Dart port of highlight.js).
  `flutter_highlight` is a dead end — it depends on `highlight.dart`, which is
  discontinued. Highlighting is never load-bearing: an unknown language, or a block still
  streaming and syntactically half-written, falls back to the plain monospace span. The
  palette **follows the app's brightness**; the app carries a full dark theme
  (`app.dart:32`), and a light palette on a dark code block is dark-on-dark.
- `apps/client` (Milestone 4: attachments, compaction, slash commands). Attachments are
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
- `apps/client` (Milestone 5: LAN pairing + auth). A `ServerConnection` is *loopback*
  (`http://127.0.0.1:8787`, no token, no pin — the server trusts that listener because
  arriving there is proof of local access) or *paired* (`https://<lan>:8788`, a pinned
  certificate and a device bearer token). The three travel together, so pointing at a new
  URL drops the pin and the device id that belonged to the old one — carrying them over
  would pin one server's certificate against another server's address. Loopback stays the
  default, so a desktop install is untouched by all of this.
  - **The refresh lives in `onResponse`, not `onError`.** dio is built with
    `validateStatus: (_) => true` so callers can read `NelleError` bodies off non-2xx
    responses, which means dio routes *every* response — 401 included — to the success
    path. The textbook interceptor is dead code here, and the symptom is not an exception:
    it is a client that silently stops being authenticated with every test still green.
  - **The refresh is single-flight and version-checked**, because the server rotates both
    tokens and keeps one pair per device. The client always has several requests in flight,
    so an expired token 401s all of them at once; a per-401 refresh presents an
    already-rotated token on the second, is told `refresh_token_invalid`, and tears down a
    working session. A 401 for a token another request already replaced is *replayed*, not
    refreshed again.
  - **Pinning is the whole trust decision.** `badCertificateCallback` fires for any
    certificate the platform will not validate — which a self-signed one never is — so
    returning `true` unconditionally (the fix every snippet suggests) disables TLS
    entirely. It compares SHA-256 of the DER against the pin, and a mismatch is refused
    with **no way to override**: the certificate is stable for five years so a pin holds,
    so a change is a re-key or a MITM and the client cannot tell which. It says exactly
    that, under a red shield — "Server unreachable" would send the user to check the one
    thing that is definitely not wrong. The web cannot pin at all (a browser decides before
    any Dart runs), so the adapter is conditionally imported and LAN mode is native-only.
  - The pairing details are **pasted or scanned as one blob**, never retyped field by
    field: the fingerprint is 32 bytes of hex, and it is also the entire trust decision. It
    travels out-of-band (clipboard, camera, a person reading it aloud), which is what makes
    the pin *pre-shared* rather than trust-on-first-use. The host offers the QR *and* the
    code *and* the URLs, because the code's alphabet has no `0`/`O`/`1`/`I` precisely so it
    can be typed, and the desktop-to-desktop case has no camera.
  - The client **probes every offered address**; `POST /api/pair` tells the device its own
    id, because `GET /api/devices` is loopback-only and a paired phone can never ask.
  - `GET /api/attachments/:id/content` serves a past message's bytes, and they are fetched
    **through the app's dio, never `Image.network`** — which opens its own client, carries
    no bearer (401) and knows nothing of the pin (handshake failure), and would break on
    exactly the device the route was added for. `storage_path` comes out of the database,
    so it is refused if it escapes the attachments tree: a row is not a capability to read
    any file on the machine.
- **Three Flutter traps the M7 param editor walked into, each invisible to `flutter analyze`
  and to every unit test.** (1) **`Map.hashCode` is identity-based in Dart.** Keying a widget on
  `params.hashCode` so a save re-seeds it looks right and is a bug: every catalog refresh parses
  a fresh Map, mints a new key, destroys the State and eats what the user was typing. Compare
  content in `didUpdateWidget` instead. (2) **`AsyncValue.guard` swallows the exception into the
  state**, so a caller awaiting a Riverpod mutation never sees it — a refused params save then
  silently does nothing: no marked rows, no message. Rethrow. (3) **forui's `FButton` lays its
  child out in an unflexed `Row`**, so a long label overflows the button (94px here) — the same
  shape as M6's 91px composer overflow on Android. Keep button labels short and put the sentence
  beside them.
- **This app is forui over a bare `FScaffold`, so it has no `Material` ancestor.** A
  Material-only widget (`Switch`, `IconButton`, anything wanting an ink splash) throws
  *"No Material widget found"* and Flutter paints a red error box where the control should
  be — while `flutter analyze` stays clean and every unit test passes. Use `FSwitch`,
  `FButton`, or a `GestureDetector`. Note the trap in the *tests*: the older widget tests
  wrap their subject in a Material `Scaffold`, which supplies an ancestor the real screen
  does not have, so a test harness can be more forgiving than the app. Host a screen in
  `FScaffold` if that is what it runs in.
- Clipboard and drag-and-drop use **`pasteboard`** and **`desktop_drop`** (plain
  platform-channel plugins, both maintained). **Do not reach for `super_clipboard` /
  `super_drag_and_drop`**, which are the obvious choice and a dead end: they pull in
  `super_native_extensions` -> `irondash_engine_context` -> **cargokit**, whose Gradle
  plugin calls `Project.exec()` — removed in **Gradle 9**, which this project is on
  (9.1.0 / AGP 9.0.1). `flutter build apk` dies, **cargokit is archived**, and
  `super_native_extensions` has not moved in a year, so no patch is coming and a fork
  would mean owning an abandoned Rust-backed native library across five platforms. The
  paste path is: an image (`Pasteboard.image`), else a *file* (`Pasteboard.files`), else
  text — a clipboard carries a picture or a file, and both are attachments; only text
  belongs in the message.
- **WSLg cannot carry an image on the clipboard between processes**, so image paste
  cannot be driven end-to-end on this machine: the WSLg bridge takes the CLIPBOARD
  selection and only preserves text, and a GTK image set by any other process (verified
  with PyGObject, and with the image set on the Windows side) vanishes. *File* paste is
  drivable and was driven (a real Ctrl+V of a copied file produced its chip), and the
  bytes-to-chip path below it is the same one the file picker uses. Do not read a failing
  image-paste drive here as a code fault without first checking `wait_for_targets()`.
- **Nelle's auth model: the listener is the authority, not the route.** The loopback
  listener (`127.0.0.1:8787`) is constructed `{trusted: true}` — arriving there *is* proof
  of local access, so it needs no token and never will; making pairing mandatory for the
  desktop would be a regression, not a hardening. The LAN listener (TLS, `0.0.0.0:8788`,
  opt-in via the `network` settings group) is `{trusted: false}`: **every** `/api/` path
  needs a device bearer except `/api/health`, `/api/pair` and `/api/auth/refresh`
  (`AUTH_ALLOWLIST`) — which must be exempt, because they are how a device gets a token in
  the first place. The gate runs *before* dispatch, so an unauthenticated LAN request gets
  `401` whether or not the route exists (no route-existence leak); `/api/pair/code` and
  `/api/devices*` answer `404` to an *authenticated* device, so **a paired phone cannot
  enrol another device or list its siblings**. Verified end-to-end over TLS.
- **A refresh rotates both tokens, and a device has exactly one token row**
  (`ON CONFLICT(device_id) DO UPDATE`): after a refresh the previous access token *and* the
  previous refresh token are dead (measured — both answer 401). A client runs several
  requests at once (chat SSE, router SSE, snapshot reload), so an expiring access token
  produces **simultaneous 401s**; a client that refreshes per-401 sends the second request
  an already-rotated token, gets `refresh_token_invalid`, and destroys its own session.
  **Any client must single-flight the refresh** — one in-flight future, every caller awaits
  it. Access tokens live 1h; a refresh token lives until it is rotated or the device is
  revoked. Pairing codes are single-use, 5 minutes, and drawn from an alphabet with no
  `0`/`O`/`1`/`I` because **they are meant to be typed** — a QR is an accelerator, never the
  only way in.
- Self-signed TLS is **pinned by fingerprint, not validated by chain**. `ensureServerCert()`
  generates the cert once and keeps it (5 years) precisely so a pinned fingerprint holds;
  the fingerprint is SHA-256 of the DER as uppercase colon-hex — byte-identical to
  `openssl x509 -fingerprint -sha256`, so compare against that rather than inventing a
  format. The pin is handed over **out-of-band at pairing time** (in the code/QR payload),
  which makes it pre-shared pinning rather than blind trust-on-first-use; do not downgrade
  it to TOFU. A fingerprint that later changes is a re-key or a MITM and the client cannot
  tell which, so it must refuse — no "continue anyway".
- **Secure storage needs a keyring, and Linux may not have one.** `flutter_secure_storage`
  needs `libsecret` *plus* something answering `org.freedesktop.secrets` (gnome-keyring,
  KWallet, KeePassXC); a bare window manager has none, and `libsecret-1-dev` is a *build*
  dependency of ours, not a user's. So the token store must report *unavailable* rather than
  throw: loopback keeps working with no keyring at all (it is unauthenticated — that is the
  point), and only remote pairing is refused, with a sentence saying why. Android/iOS/macOS/
  Windows are unaffected (Keystore/Keychain/credential store are OS-provided).
- **A drive must never share the developer's keyring.** gnome-keyring pops a GUI dialog
  whenever a collection must be *created or unlocked*, which blocks an unattended drive
  exactly as it blocks a human. Give the drive a throwaway keyring where neither is ever
  true — an isolated `XDG_DATA_HOME`, the `default` alias pre-seeded to `login`, and an
  empty-password login keyring unlocked on stdin:
  `printf 'login' > "$XDG_DATA_HOME/keyrings/default"` then
  `dbus-run-session -- sh -c 'printf "\n" | gnome-keyring-daemon --unlock --components=secrets; flutter run -d linux'`.
  A real Linux user still sees their OS keyring prompt on first pair, once; that is their
  desktop asking, and it is correct.
- **A physical phone on the LAN cannot reach this WSL2 machine.** WSL2 is NAT'd by default,
  so Nelle binds the VM's `172.31.x.x` while the phone is on the host's `192.168.x.x` — the
  two do not meet without `networkingMode=mirrored` in `.wslconfig` or a Windows `netsh
  portproxy`. **An Android emulator needs neither**, because it runs *inside* WSL and shares
  its network namespace: it dials `https://172.31.x.x:8788` directly. That makes the emulator
  the way to drive the phone, and a second desktop instance pointed at the TLS listener the
  way to drive a remote client. Neither is a bug to fix — they are the shape of the machine.
- **Driving the Android emulator here needs two non-obvious flags.** It aborts with `Unable
  to create /run/user/1000/avd/running` because WSL has no `XDG_RUNTIME_DIR`, and it hangs at
  0.1% CPU forever waiting on a WSLg window — so give it a writable `XDG_RUNTIME_DIR` and run
  it **`-no-window`**. Headless costs nothing: Marionette attaches to the Dart VM over adb and
  screenshots come from Flutter, not from the emulator's window.
  `emulator -avd <name> -no-window -gpu swiftshader_indirect -no-snapshot`, then
  `flutter run -d emulator-5554`. KVM needs the user in the `kvm` group; without it the boot
  silently falls back to something unusable.
- **A phone is not a narrow desktop, and the difference finds bugs.** Ten minutes on Android
  found a composer that overflowed by 91px (an unflexed `Row` a 1280px window had always been
  wide enough to hide) and a conversation list that never reloaded after pairing (the notifier
  `read` its repository instead of watching it — invisible on a desktop, where loopback works
  *before* you pair, and the first thing that happens on a phone, where it cannot). Widget
  tests must pin the phone size (`tester.view.physicalSize`) to see either.
- The Flutter client is instrumented for **agent-driven UI testing**: an agent drives
  the running app the way a browser MCP drives a page. `lib/main.dart` initializes
  `MarionetteBinding` **only under `kDebugMode`** (release keeps the plain
  `WidgetsFlutterBinding`, so the instrumentation never reaches a shipped app),
  and the repo registers two stdio
  servers (in `.mcp.json` for Claude Code and `.codex/config.toml` for Codex):
  `marionette_mcp` (widget inspection plus `tap`, `enter_text`,
  `swipe`, `scroll_to`, `take_screenshots`, `get_logs`, `hot_reload`) and the
  official `dart mcp-server` (runtime errors, widget tree, hot reload, run tests,
  analyze). Prerequisite: `dart pub global activate marionette_mcp`, with
  `~/.pub-cache/bin` and the Flutter SDK bin on PATH. Run the app in debug, and the
  agent attaches to its Dart VM Service. Restart the agent session after changing
  `.mcp.json` — MCP servers load at session start.
- **A client change is not done until it has been driven in the running app.**
  `flutter analyze` + `flutter test` green is necessary and not sufficient: 36 passing
  tests did not catch a refused message silently eating the user's typed text, and
  one minute of driving the UI did. So for every UI-affecting change: run the app in
  debug, `connect`, `get_interactive_elements`, drive the real flow (`tap`,
  `enter_text`, `scroll_to`), `take_screenshots` **and look at them**, and check
  `get_logs` + `dart`'s `get_runtime_errors` for exceptions and overflows. Assert on
  what is on screen, not on what you believe you built, and never ask the user to
  eyeball a screen you could have driven yourself. Deliberately drive the edges,
  because that is where client bugs live and where no unit test looks: empty states,
  error states (`llama_server_stopped`, `model_load_failed`, `context_overflow`), a
  refusal before `run.started`, mid-stream abort, degenerate content, the narrow/wide
  layout break, switching conversations mid-run, and an unknown event type. Any bug
  found this way gets a regression test before the fix is committed. Marionette
  matches by `ValueKey` or visible text, so give every interactive widget a stable
  `ValueKey` — without one you are tapping raw coordinates, which silently rots.
- **Two testing tools, and they are not alternatives.** **Marionette is exploratory** — the
  agent drives the running app while iterating on a task, which is how the bugs above get
  found. **`integration_test` is the regression tool** — it *pins* what driving discovered,
  so it cannot come back. A bug found by driving becomes a device test; a device test is
  never how you explore. The device suite runs the **real** app (`main()`, real providers,
  real dio, real HTTP) against a **real Nelle server** — `scripts/serve-fixture.ts`, on a
  throwaway `.nelle-device`, port 8797, with `NELLE_LLAMA_PORT=18081` so it can never adopt
  the developer's llama-server. Two tiers:
  - **`bun run test:device`** (fast, ~7 min) — llama.cpp **stopped**, which is what a fresh
    install is and where most error paths live. One entrypoint (`integration_test/app_test.dart`)
    calling suite functions, because **multiple `integration_test` files fail on Linux**
    ("Unable to start the app on the device").
  - **`bun run test:device:slow`** (~2 min, on demand) — a **real gemma-4-E2B** really
    generating. A chat app whose chatting is never tested end to end has a hole in the middle
    of it, and stubbing llama.cpp would test nothing: the whole question is whether Nelle, Pi,
    llama.cpp and the client agree about a stream of tokens.

  **The same fast tier runs on the phone** — `bun run test:device -- -d emulator-5554`, against
  a headless emulator (see the emulator flags below). It needs no pairing, no TLS and no pin:
  `adb reverse tcp:8797 tcp:8797` maps the emulator's own loopback to the host's port, so the
  fixture's *trusted* listener answers and the whole pairing stack stays out of the way. (Which
  is deliberate — pairing is covered by `devices.test.ts` and three client test files, and making
  every device test carry a TLS handshake and a Keystore write would be testing the harness.)

  Run it on both, because **the phone finds what the desktop hides**. It immediately caught a
  test asserting the forked-from conversation was "still in the sidebar" — a *desktop* assertion
  wearing a general one's clothes: below the 760px breakpoint the chat **replaces** the list
  (`workbench_screen.dart`), so there is no sidebar on screen to look in, and the check failed on
  a layout behaving perfectly. The lesson generalizes: **assert the claim, not a proxy for it that
  happens to be visible on a 1280px window.** "The original is unchanged" is a fact about the
  server, so ask the server.

  The traps, each of which cost a debugging session:
  - **`pumpAndSettle` does not wait for network I/O.** It settles *frames*, and an HTTP
    response schedules none until it lands — so it returns happily mid-request and the next
    `expect` reads a screen that has been told nothing. Worse, `expect(finder, findsNothing)`
    then passes **vacuously**. Assert presence with `pumpUntil`, never a bare `pumpAndSettle`.
    (Widget tests never meet this, because `stubDio` answers synchronously.)
  - **A finder matches off-screen widgets**, and `tap()` at off-screen coordinates hits
    nothing and fails *silently*. Use `tapAt` (which `ensureVisible`s first). `tester.pageBack()`
    is useless here: it looks for a Material/Cupertino back button and this app is forui over a
    bare `FScaffold`.
  - **`tester.enterText` is a silent no-op on a field that is not focused** — the most expensive
    trap in the suite. It does not throw and does not warn: the text is simply not there, and the
    test sails on to assert against a screen where nothing was typed, so the failure surfaces
    wherever the *consequence* was expected and nowhere near the line that broke. The *first*
    `enterText` in a test usually works, because nothing has taken focus yet; the second often does
    not, because a completed run rebuilds the composer and the text-input connection goes stale.
    Use `typeInto`, which taps the field first and then **verifies the text landed**. (This cost an
    hour: `/compact` was never typed, so the send button did nothing, and the failure appeared three
    minutes later as a compaction that never started.)
  - **The seeded fixtures are read-only.** Every test drives the same server, in one process,
    in order, so a test that renames a seeded conversation breaks the next test that looks for
    it by name. A mutating test calls `createOwnConversation()`, which answers the **id** — and a
    slow test must use that rather than looking the conversation up by title, because **the server
    generates a title from the first exchange**: the moment a real model answers, the chat is no
    longer called what the test called it. It is a race, too (title generation is fire-and-forget),
    so the same test passes on a fast day and fails on a slow one.
  - **A hand-seeded Pi session can be READ but not CONTINUED.** Entries written directly with
    `SessionManager.appendMessage` replay fine, but Pi's agent then completes with no text at
    all. Only a session Pi itself created (`POST /api/conversations`) can be chatted with — so
    the slow tier brings its own conversations, and `SessionManager.create()` allocates a path
    without writing a file, which is why the "empty" fixture is created through the API too.
  - Only **one binding** may exist, so `main.dart` guards on `BindingBase.debugBindingType() == null`
    before initializing `MarionetteBinding` — otherwise it collides with
    `IntegrationTestWidgetsFlutterBinding`.
- **Test against the small models, not the real ones.** For any model-backed test
  (agent-driven UI drives, the slow device tier, a real generation), use
  `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` (4.22 GB) — and add
  `unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL` (2.62 GB) as the *second* model whenever a
  test needs two. `gemma-4-26B` and `Qwen3.6-35B` are the real workloads; loading one
  costs tens of seconds and a lot of RAM, which makes the drive loop useless. Import
  with `POST /api/huggingface/use {repoId, quant}` — never hand-roll the section id
  (`hf-repo` keeps the exact `…:UD-Q4_K_XL` ref; the section id uses llama.cpp's
  canonical `…:Q4_K_XL`). **Simultaneous multi-model testing needs
  `runtime.modelsMax >= 2`**: at the default `1` the router evicts the first model
  when the second loads, so the test would be exercising eviction and reporting a
  pass — worse than a failure, because it looks green. So before any multi-model run,
  read `GET /api/runtime` and assert `modelsMax >= 2` rather than assuming it. It is a
  **settings group** (`runtime`), so it lives in `.nelle/settings.sqlite` (git-ignored app
  data), not in code: the registry keeps the default at `1` on purpose, because a fresh
  install on memory-constrained hardware must not try to hold two models. Raise it per
  machine with `PATCH /api/settings/runtime`, which needs a llama.cpp restart.
- **`apps/server/src` has a shape now, and the root holds exactly three files** — `index.ts` (the
  listeners), `server.ts` (the router wiring and the auth gate) and `openapi.ts` (the document
  builder, which consumes `router.routes()` and is *not* a route). Everything else lives in
  `http/ pi/ conversations/ llama/ models/ attachments/ settings/ auth/ db/ lib/ contracts/`.
  Two names are easy to collide and must not be: `pi/hostTools.ts` is the host file/shell tool
  repository, and `openapi.ts` is the builder rather than the route that serves it.
- **`pi/` is eight modules and a harness, and three of its names sit next to a name they are not.**
  `harness.ts` keeps what the run map welds together — `runPiPrompt` and the nine methods that touch
  `#activeRuns` — and everything that came out of it takes its dependencies as arguments, so none of
  it reaches back. The three near-collisions, each deliberate: **`pi/tools.ts`** is the subscriber
  that *listens* to Pi's tool events (and fails closed when host tools are off), while
  **`pi/hostTools.ts`** is the repository it writes audit rows to and the switch it checks;
  **`pi/models.ts`** writes `.pi/models.json` — how Nelle describes a model *to Pi* — while
  **`models/`** is Nelle's own catalog; and **`pi/toolCalls.ts`** correlates three events into one
  call, which is a different job from either tools file. The rest read as they are named:
  `events.ts` (the SSE envelopes), `errors.ts` (the coded refusals), `projection.ts` (Pi's session
  file read back into rows, and the variant machinery that keeps a regenerated-away answer),
  `attachments.ts` (the bytes a prompt carries), `session.ts` (constructing a Pi session).
- The HTTP server is `Bun.serve` over a small native router
  (`apps/server/src/http.ts`), not Fastify: handlers return a `Response`, and it
  owns JSON-body parsing, zod→400 mapping, and CORS. It serves no static files:
  an unmatched path is a coded JSON 404, whether or not it starts with `/api/`.
  SQLite is `bun:sqlite` (`Database`, used directly, no wrapper).
  Subprocesses use `Bun.spawn`: short commands (`process.ts`) and the
  long-running detached llama-server (`llamacpp.ts`). `Bun.spawn` does **not**
  inherit the parent env by default (`node:child_process` does), so the
  llama-server spawn passes `env: process.env` explicitly — PATH for shared
  libs, `LLAMA_ARG_OFFLINE`, CUDA vars. `detached` gives POSIX `setsid()` so
  `process.kill(-pid)` kills the group, and the child outlives a restart for
  pid-file adoption; verified end-to-end on Linux, macOS/Windows still to
  confirm. `index.ts` runs `Bun.serve`.
- **A fresh clone runs `bun run setup`, and that is the whole of it.** `setup` does only what this
  repository *owns* — `bun install`, `flutter pub get`, `dart pub global activate marionette_mcp`,
  and arming the pre-push hook. **It installs no system toolchain, deliberately**: not Bun, not the
  Flutter SDK, not the JDK, not the Android SDK, not Xcode, not a keyring. Five reasons, each
  sufficient alone — they need **sudo**; there is **no single correct way** to install them (Flutter
  is a git clone here, and picking one for the user fights the one they already chose, giving *two
  SDKs and a PATH fight*); "install X" is **not idempotent** when X already exists elsewhere;
  `sdkmanager --licenses` and Xcode need **interactive consent** a script cannot honestly automate;
  and `setup` runs *under Bun*, so it can never install Bun. `bun run doctor` does the hard half
  instead — it knows *what* is needed, at what version, and prints the exact command **for the
  detected OS**, marking each item required or optional *relative to the work this host can do* (a
  server-only contributor is not failed for lacking the Android SDK).
- **The pre-push hook is committed; only its activation is not.** `.githooks/pre-push` is an
  ordinary tracked file and git tracks its **executable bit**, so it arrives with the clone. What
  cannot be committed is `git config core.hooksPath .githooks` — that lives in `.git/config`, and
  git deliberately will not arm a hook on clone, because that would mean `git clone` executes
  arbitrary code from a stranger. `bun run setup` sets it; `bun run hooks on|off|status` toggles it.
  **`setup` records intent (`nelle.hooks`) separately from the mechanism**, or an `off` would last
  only until the next `setup` silently re-armed it. It is local config, so each clone decides for
  itself.
  - **The hook scopes itself to what changed**, and that is what makes it survivable: the full gate
    is ~54s, and at ~10 pushes a day an unscoped hook is nine minutes of daily waiting — which is
    exactly how `--no-verify` becomes muscle memory, and then it protects nothing. Server files run
    `bun run test`; `apps/client/**` runs `flutter analyze && flutter test`; **only** a build-config
    change (`package.json`, `bun.lock`, `pubspec.*`, the platform dirs) also builds. A pure Dart/TS
    edit essentially cannot break a build that `tsc` and `flutter analyze` would not already catch —
    what breaks builds is *dependencies and platform config*, which is precisely what bit us when
    `super_clipboard` pulled in cargokit and `flutter build apk` died while `flutter analyze` stayed
    clean. Docs-only pushes skip entirely.
  - It **fails loudly** if a tool it needs is missing rather than skipping half the gate — a gate
    that quietly does nothing is worse than no gate, because you trust it.
- **`scripts/lib/hostCapabilities.ts` is the single answer to "what can this machine do?"**, shared
  by `doctor` and `build`. Two consumers, one module, on purpose: worked out separately they would
  drift, and `build` would offer a target `doctor` calls impossible. **Flutter cannot cross-compile
  desktop or iOS targets** — a macOS build needs a Mac, Windows needs Windows — so `build` refuses an
  impossible target *up front, with the reason*, instead of letting the user find out from a CMake
  stack trace three minutes in. (The **server** binary does cross-compile, but a cross-compiled one
  ships without the target's `@napi-rs/canvas` native binding and cannot read a PDF — build it
  natively per OS, as CI does.)
- **CI is the only Mac, Windows and iPhone this project has.** The repo is public, so **standard
  GitHub-hosted runners are free on every OS** (only *larger* runners bill), and `.github/workflows/ci.yml`
  uses that to verify Nelle where the one development machine — a WSL2 box — cannot:
  - **The compiled-binary smoke test runs on Linux, macOS and Windows.** It builds the binary,
    *runs it*, and feeds it a real PDF. This exists because `bun build --compile` once reported
    success on a binary that could not read a single PDF, and that failure class is per-OS by
    nature (native bindings, path resolution, `dlopen`). Building **natively on each runner** also
    removes cross-compilation entirely — no `@napi-rs/canvas` platform-binding juggling, because
    each OS builds its own. **Never cross-compile a release server binary**: it ships without the
    target's Skia binding and cannot read a PDF.
  - **The device suite runs on five platforms**, not one. The fast tier needs *no model* (llama.cpp
    is deliberately stopped), so it is CI-able as it stands: Linux (under `xvfb`), **Windows**,
    **macOS**, the **iOS Simulator**, and an Android emulator. Windows, macOS and iOS had never been
    run at all — they are `continue-on-error` until they go green, because a platform nobody has
    ever tried should not block a server refactor. **Remove that the moment each passes**; a
    permanently tolerated failure is not a test.
  - `pull_request`, never `pull_request_target` — a fork's PR gets no secrets, which is correct
    because no job needs one. Default `permissions: contents: read`; only the release job may write.
    **Never a self-hosted runner on a public repo**: a fork's PR would execute arbitrary code on
    your machine.
- **The macOS app needs `com.apple.security.network.client`, and Flutter's template does not give
  it to you.** Nelle is a *client*: it talks to the server over loopback and, when paired, the LAN.
  The macOS **App Sandbox blocks every outbound connection** without that entitlement — so the app
  builds, launches, and then fails every request with `SocketException: Connection failed (OS Error:
  Operation not permitted, errno = 1)`. Not degraded: **useless**. The release build had *no*
  network entitlement at all and the debug build had only `network.server` (the Dart VM service).
  Nobody noticed because macOS had never been built or run; CI failed 14 of 15 device tests on its
  first attempt and found it. Both `macos/Runner/{Debug,Release}.entitlements` now carry it.
- **A lazy `ListView` never builds a row that is far off-screen, so *waiting* for it cannot work.**
  This is the inverse of the usual trap and it bites on exactly the platforms with a shorter
  viewport: `tapAt` used to `pumpUntil` first, which sat for 15s waiting for a widget nothing would
  ever build. It **scrolls first** now (`scrollUntilVisible`), then waits. Invisible on a tall
  desktop window where the settings list happens to fit; fatal on a phone, on Windows, and on any
  shorter window — 14 of 15 tests passed on Windows and the one reaching for the Models section
  below the fold timed out.
- **The unit suite runs on Windows and macOS in CI, and the first run found only *harness* bugs —
  never a product bug.** Worth knowing, because a red Windows job looks alarming and was not:
  - **POSIX shell fixtures do not run on Windows.** Several tests stand a `#!/bin/sh` script in for a
    real binary (a fake `llama-server` printing a `--help` catalogue; a fake build command writing to
    both streams and exiting 3). Windows has no shebang and no `sh`, so spawning them is
    `ENOENT: uv_spawn`. They are `test.skipIf(needsPosixShell)` — what they verify (line splitting
    across chunk boundaries, stream ordering, exit codes, `--help` parsing) is platform-independent
    logic already covered on Linux and macOS, and on Windows the *product* spawns a real
    `llama-server.exe`. It is only the stand-in that is POSIX.
  - **`fs.rm` throws `EBUSY` on Windows** while anything still holds a handle, and SQLite does not
    always release immediately after `close()` where POSIX would let the unlink through anyway.
    Tests were failing in **teardown with their assertions already passed** — the worst kind of red,
    because it looks like a product bug and is not one. Use `removeTemp()`
    (`tests/unit/helpers/platform.ts`), which retries and then gives up: a temp directory that will
    not delete is not a test failure.
  - **Any test that reads a repository file and matches on line structure must normalise CRLF.** Git
    checks out with CRLF on Windows, so a regex written with `\n` matches nothing there.
  - **`fs.stat().mode & 0o111` is meaningless on Windows.** To assert a file is executable, assert
    *git's index mode* (`git ls-files -s` → `100755`), which is identical on every platform and is
    what a fresh clone actually restores.
- **Bun's default 5s test timeout is a Linux assumption.** The macOS and Windows CI runners are
  slower — the first `pdfjs` load and a Pi session creation both cross it — so tests were failing
  having proved nothing about what they test. CI runs the suite with `--timeout 30000` on those two
  and keeps the 5s default on Linux, so a genuine hang is still caught somewhere. If a test does its
  own waiting (a poll loop, a scaled deadline), it needs an **explicit** timeout larger than its own
  wait, or it dies before its own assertion runs — that has now happened twice.
- **`libsecret-1-dev` is a *build* dependency of the Linux client, not an optional one.**
  `flutter_secure_storage_linux` fails CMake outright without it, which is how the Linux device job
  failed on its first CI run. That is a different thing from the **runtime** keyring (something
  answering `org.freedesktop.secrets`), which genuinely is optional — loopback is unauthenticated by
  design and needs none.
- **The release workflow is tag-only, and that is enforced by a test.** Publishing downloadable
  binaries under the owner's name is a deliberate human act, not something an automated run does on
  its way past. `release.yml` triggers on `v*` tags and nothing else; a push to `main` can never cut
  a release, and `bootstrap.test.ts` fails if that ever changes. Release *assets* go to a GitHub
  **Release** (free, unlimited, permanent, downloadable without a login) rather than Actions
  artifacts, which expire, need an account, and are metered even on public repos. Every server
  binary is smoke-tested before it is attached: a build that cannot read a PDF must never reach a
  download page.
- Primary checks are `bun run format:check`, `bun run lint`, `bun run check`,
  `bun run test:unit`, and `bun run test` (the composite: format check, lint,
  `tsc`, unit tests). There is no web build and no browser suite to run; the
  client's own checks are `flutter analyze`, `flutter test`, and the device tiers
  (`bun run test:device`, `bun run test:device:slow`).
- **`tsc` typechecks `tests/` and `scripts/` too, and that is load-bearing.** They were
  outside `tsconfig.include` until they were added, so **a stale import in a test failed at
  `bun test` runtime and never at `bun run check`** — which is exactly backwards when a
  refactor moves a value between modules, because Bun erases types and only *notices* at
  the moment the test runs. Turning `tsc` on them surfaced 36 real errors, including a test
  importing `ConversationEntryProjection` from a module that never exported it, a mock
  returning `null` where its own contract declared `string`, a factory whose spread
  silently overwrote two keys it had just set, and `.catch(e => e)` idioms that would have
  passed a *resolved* promise into an error assertion. **Do not narrow the include list
  again.** If a type is wrong, fix the type — never `any`, never `@ts-expect-error`.
- Formatting and linting use Oxfmt and Oxlint. Run `bun run format` for
  formatter writes and `bun run lint:fix` for safe lint fixes.
- **Stopping the dev server: two traps, and together they look exactly like a
  shutdown hang.** `bun run dev` is **`bun --watch apps/server/src/index.ts`**, which is a
  *supervisor plus a child* -- **two processes with the identical `ps` cmdline**
  (`bun apps/server/src/index.ts`), sharing one port between them. Kill them and the
  supervisor may restart its child, so the port is re-bound a moment later and the
  next start dies with `EADDRINUSE` while `ps` still shows two survivors: it reads as
  a server that will not die. It is not. Shutdown is sound and **measured** -- SIGTERM
  exits in ~260 ms when idle, with an SSE stream held open, mid-run, *and* while
  holding a managed llama-server child (which survives on purpose: it is detached, for
  pid-file adoption). Use **`bun run serve`** (a single process) when you need to stop
  it deterministically, and kill by the pid you captured, not by pattern. Second trap,
  and it is worse: **`pkill -f "bun.*apps/server"` matches the agent's own shell**,
  which contains that string in its command line -- so it kills the tool call and
  returns **exit code 144** rather than doing anything useful. Kill by pid.
- Unit tests run on `bun:test` with `node:assert/strict`; a `createTestServer`
  helper (`tests/unit/helpers/testServer.ts`) drives the `Bun.serve` `fetch`
  handler through an `inject`/`close` surface, so route tests did not churn.
- MCP servers are configured **per project, in the repo**, not globally: Claude Code
  reads `.mcp.json` and Codex reads `.codex/config.toml` (Codex does not read
  `.mcp.json`). Keep the two in sync — both register `marionette` and `dart`, and
  nothing else (see the Flutter client bullets above).
  Restart the agent session after changing either file; MCP servers load at session
  start. Each command exports `PATH` explicitly, because `~/.bashrc` returns early
  for non-interactive shells, so a bare `bash -lc` misses `~/.pub-cache/bin` and
  resolves `dart` to the stale **Windows** Flutter on `/mnt/c`.
- Nelle stores app data under `.nelle/` by default. Do not commit
  generated app data, test-harness app data (`.nelle-device/`), downloaded models,
  llama.cpp builds, test reports, or logs.
- **Model weights live in `.nelle/models/`, not in the user's global
  `~/.cache/huggingface/hub`.** Nelle hands llama-server `LLAMA_CACHE=<dataDir>/models`,
  which `common/hf-cache.cpp` uses **verbatim as the Hugging Face hub root** (the layout is
  HF's own: `models--org--repo/{blobs,snapshots,refs}`, with *relative* symlinks, so a repo
  directory is self-contained and moves with a plain `mv`). Weights are the largest thing
  Nelle owns by two orders of magnitude and were the last of its data living somewhere it
  did not control. Three things follow: it can account for the disk (and
  `common_download_remove()` means deleting a model could reclaim it, which is not safe in
  a shared cache); "what llama.cpp has cached" becomes "what Nelle downloaded"; and a
  throwaway `NELLE_DATA_DIR` no longer reaches into the developer's real 50 GB -- the same
  class of surprise as a test run adopting a developer's llama-server.
  **An explicit choice wins**: if the user has set any of `LLAMA_CACHE`, `HF_HUB_CACHE`,
  `HUGGINGFACE_HUB_CACHE` or `HF_HOME`, Nelle sets nothing. `LLAMA_CACHE` outranks all of
  them in llama.cpp's own resolution order, so setting it would silently overrule someone
  who had deliberately chosen to share a cache or to keep 50 GB on another disk.
- **`models.ini` is the catalog, and llama.cpp's router is not.**
  `server_models::load_models()` calls `load_from_cache()` **unconditionally** -- there is
  no flag to disable it -- so the router advertises every GGUF in the download cache as a
  loadable model, plus a synthetic `default`. Measured live against a four-section preset:
  **six** models, including an `unsloth/gemma-4-12B-it-qat-GGUF` nobody had configured
  (`source: "cache"`, `can_remove: true`). Those are not Nelle's: they have no params, no
  `/api/models` row, no Pi entry, and nothing can manage them. `mergeRouterModels` therefore
  **drops any router model that matches no configured section** (`findConfiguredSectionId`
  already matches on section id, runtime id, alias and `hf-repo`, so an unmatched one is
  genuinely unknown). A configured model the router has *not* listed still appears, seeded
  as `unloaded` -- the filter only removes models Nelle never configured, never hides one it
  did. A Nelle-owned cache narrows the problem but does not remove it: delete a model from
  `models.ini` and its blobs remain, so it would return as a cached stranger.
- **Pi is the only chat path, and there is no fallback.** There used to be a "direct llama.cpp
  fallback", and it was not one: it ran only when `NELLE_PI_DISABLED=1` — an env var nothing in the
  server or the scripts ever set, only a test — **and** the conversation was `legacy-default`, which
  only the retired migration ever created. Unreachable in production, untested end to end, and it
  supported no tools, no reasoning, no compaction and no regenerate. The README advertised it as a
  real capability; that sentence was false. A Pi failure surfaces as a coded stream error the client
  renders, and **that is** the graceful degradation. Do not reintroduce a second, permanently
  second-class chat engine: an emergency path that never runs is the least-tested code in the
  repository, waiting to execute at the worst possible moment. If resilience is ever a real
  requirement, build it properly — triggered by an actual Pi failure, working for *any* conversation,
  writing through the conversation repository so the client can see it, and tested.
- **`legacy-default` is gone, and `state.json` no longer holds a chat.** The migration that lifted a
  chat out of `.nelle/state.json` into a Pi session existed for installs that do not exist, which is
  exactly what the rule below forbids. `AppState` now carries the `models.ini` catalog mirror and
  llama.cpp's address, and nothing else. Conversations come into existence **only** through
  `POST /api/conversations`, so a fresh server has none — and that is correct, not a bug to paper
  over with a placeholder.
- Nelle has no users yet. Do not write code to migrate old installs: when a
  change makes existing app data wrong, edit this repository's `.nelle/` by hand
  and move on. SQLite `schema_migrations` stays, because it is also how a fresh
  database is built, but a *data* migration for the benefit of installs that do
  not exist is dead code with a test suite attached.
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
- `modelsMax` and `sleepIdleSeconds` are the `runtime` **settings group**
  (`GET`/`PATCH /api/settings/runtime`), and `llamacpp.ts` reads them from
  `SettingsRepository` when it builds `--models-max` / `--sleep-idle-seconds`. Defaults
  are `1` and `90`, and a change needs a llama.cpp restart -- which the served help text
  says, because a control that appears to do nothing is a bug report. `state.json` keeps
  only llama.cpp's *address* (host, port), which is not a user setting.
- Nelle writes no context size. It writes a *floor* for llama.cpp's auto-fit --
  `fitc` (`--fit-ctx`) = `PI_MINIMUM_CONTEXT_TOKENS` (32,768) in `[*]` -- and
  llama.cpp picks the window. `--fit` is on by default and interpolates an unset
  context between the model's trained window and `--fit-ctx`, whose own default
  is 4,096. `c = 0` is not "the default": `common/arg.cpp` reads it as "the user
  explicitly wants the full trained window" and disables fit reduction.
- The floor is 32,768 because 16,384 does not work, and this is measured, not
  assumed. gemma-4-26B's empty-conversation prompt is **13,458 tokens** (host
  tools off, reasoning `max`), Pi's `clampMaxTokensToContext` reserves 4,096
  more, and a reply under 256 tokens cannot finish a sentence: a turn needs
  17,810. On a 16,384 window the arithmetic is negative, so `max_tokens` clamps
  to 1 and every reply stops after one token with `finish_reason: "length"` --
  which is what the old `c = 16384` default did, while looking like it worked.
  `PI_AGENT_PROMPT_TOKENS` (9,439) is Pi's *own* estimate and a deliberate
  lower bound: it may let a message through that then reports
  `reply_budget_exhausted`, but it must never refuse one that would have worked.
  Keep the arithmetic in `apps/server/src/contracts/piContext.ts`.
- What a conversation actually gets is llama.cpp's to report, never Nelle's to
  assume. `effectiveContextWindow()` (`apps/server/src/contextWindow.ts`) is the
  one resolver: `model_cache.context_window` (llama.cpp's `/props` answer, always
  wins) ?? the configured `c` cap (a prediction) ?? `null`. `null` is a real
  value and must be handled as one: the context bar shows usage with no total,
  the image pre-flight is *skipped* rather than refusing, and Pi never sees it
  (`requireContextWindow` asserts, and `writePiModels` omits a model whose window
  is unknown). Coercing `null` to a number is the way to break this silently --
  `maxAffordableImages(0)` is `0`, which refuses every image. Cached Pi sessions
  are keyed by `(model, contextWindow)`, because Pi bakes the window in at
  construction and clamps against it for the session's life.
- `contextSizeFromParams` answers `undefined` (the section is silent, so `[*]`
  cascades), `null` (`c = 0`, an explicit removal of a global cap), or a number.
  Collapsing the first two makes a per-model `c = 0` inherit the cap it was
  written to remove. `models.ini` param payloads are full replacements, so an
  empty object clears the section -- that is what makes a cap removable.
- Nelle does not police how a model is loaded. `c`, `ctk`, `ctv`, `ngl`, `cmoe`,
  `ncmoe` and `ot` are the user's levers, and a MoE model with its experts on the
  CPU has a memory profile no estimate of ours would get right. Write what the
  user asked for, let llama.cpp load it or fail, and surface the failure: the
  router reports `status.exit_code`, and the child's stderr is already in
  `.nelle/logs/llama-server.log` behind its pid.
- **`c` is the one exception, and it is a bound, not an estimate.** Everything above
  assumes a bad value *fails the load*. `c` does not: it is the only lever that
  **bypasses `--fit`** (which by design only adjusts arguments the user left *unset*), so
  llama.cpp allocates a KV cache for whatever integer it is handed without ever asking how
  much memory exists. `c = 900000000` does not fail — it takes the machine down, logging
  `loading model` and then nothing at all, because nothing survives to write an error. (Not
  hypothetical: it killed this WSL2 VM mid-drive. Under WSL2 the VM balloons its memory from
  the Windows host, so the blast radius is the whole VM rather than the one process an OOM
  killer would have shot.) So `validateModelParams` refuses `c` above
  **`MAX_CONTEXT_EXTENSION_FACTOR` (32) × the model's trained window**, and *warns* on any
  overshoot at all.
  - **Running past `n_ctx_train` is legitimate**, which is why the ceiling is generous and the
    overshoot only warns. RoPE/YaRN rescaling extends a model's context, llama.cpp ships the
    flags (`--rope-scaling {none,linear,yarn}`, `--yarn-orig-ctx`), Qwen's own model cards tell
    you to do it, and llama.cpp permits it with nothing but a warning of its own
    (`llama-context.cpp`: `n_ctx_seq (%u) > n_ctx_train (%u) -- possible training context
    overflow`). Nelle mirrors that. But the real band is 2x–8x, and the typo is 6,866x: 32x sits
    an order of magnitude above anything anyone wants and three below the fat finger, so it
    refuses nothing real.
  - It is **not** a memory estimate — it is one integer against a number llama.cpp itself
    reported (`model_cache.context_train`). For a model that has **never loaded** there is no
    window, so neither the ceiling nor the warning fires: inventing a bound would refuse a
    legitimate long-context model on its very first load.
  - Guard **every spelling** (`CONTEXT_SIZE_KEYS`: `c`, `ctx-size`, `LLAMA_ARG_CTX_SIZE`) —
    `get_map_key_opt` treats them as one option, so a guard that knows only `c` is stepped
    around by a user who typed `ctx-size`, and llama.cpp allocates all the same. Case-sensitive:
    `-C` is `--cpu-mask`. `c = 0` is never refused (it means "the full trained window").
    `fitc` is *not* guarded: it runs through `common_fit_params`, which is memory-aware.
  - **A `suggestion` means two different things**, and one implementation for both is a bug: for
    an `unknown` key it is the nearest real option and replaces the **key**; for `out_of_range`
    it is the largest workable size and replaces the **value**. Applying both to the key field —
    the obvious single implementation — renames `c` to `4194304`.
- **A runtime that will not start must say why, and `waitForHealth` must not wait for a corpse.**
  `llama-server exited with code 1` is true and worth nothing; llama.cpp had already written the
  reason, naming the offending key *and* its section (`option 'x' not recognized in preset
  '<section>'` — which a user *can* hit, because `models.ini` is hand-editable and only the API
  validates it). `describeExit` takes the last `E` line from the log and appends it to the exit
  code. The exit code is what makes that line *the reason*: an `E` on its own is not a failure —
  a **successful** offline load of a pinned model logs `E get_repo_commit: GET failed (404)`
  every single time. And `waitForHealth` now gives up the moment `#process` goes null rather
  than polling a dead port for its full 30s deadline, so a doomed start fails in ~200ms with the
  reason instead of after half a minute with a timeout that blames the port.
- **A `LlamaCppManager` test must pin `NELLE_LLAMA_PORT`, or it adopts the developer's
  llama-server.** `waitForHealth` polls `host:port` and cannot tell a llama-server it started
  from any other one; the default is **8080**, which is exactly where a real one is running. A
  test whose subject is a llama-server that *died* will therefore watch its fake binary exit,
  poll 8080, find the live router, and report the doomed start a success — passing alone and
  failing in the suite, or worse, passing in both while testing nothing. This is the same trap
  that makes the device fixture pin `18081`.
- **A model whose child died at startup is `unloaded`, never `failed`, and the exit code is the
  only evidence.** `POST /models/load` answers `{success: true}` — the router accepted the
  *request* — and if the child then exits before loading a byte (a bad `ctk` value, a preset it
  will not parse), llama.cpp leaves the model at `unloaded`, records `status.exit_code`, and
  nothing else ever happens. Measured against the real router: **7 seconds of polling,
  `unloaded` and `exit_code: 1` on every single tick — no `loading`, no `failed`.** So
  `ensureModelRunnable` treats `unloaded` + a nonzero exit code as a failure, but only after
  `MODEL_LOAD_START_GRACE_MS` (3s): the exit code cannot say *which* attempt it belongs to,
  because a previous failure leaves the same `1` sitting there while the next load is starting.
  A real load reaches `loading` within a second. Without this the run grinds out its full 30s
  deadline and reports "did not finish loading" — a bare `model_load_failed` half a minute
  after llama.cpp knew the reason and wrote it down. `exitCode` is served on
  `LlamaRouterModel` so a client renders it without reaching into `raw`.
- **`POST /api/llama/models/:id/load` waits, and that is load-bearing.** It used to proxy
  `/models/load` straight through and answer the router's instant `{success: true}`, which was
  wrong three ways at once: a Load that *died* looked exactly like a Load that did nothing; a
  Load that *succeeded* never pinned the weights (`pinToDownloadedWeights` runs on a successful
  load, and only `ensureModelRunnable` called it — so the same model pinned itself when a chat
  run loaded it and stayed unpinned when Settings did); and it claimed success for a model still
  loading. It calls `ensureModelRunnable` now, the same thing a run calls. `loaded: false` means
  the model was **already runnable** — a load that was not needed, not one that failed, which
  throws.
- **Shutdown is bounded (`SHUTDOWN_DEADLINE_MS`), and the deadline is the fix rather than a
  workaround for one.** `shutdown()` awaits two socket servers and an `app.close()` that has
  llama.cpp fetches and SSE subscriptions behind it; any one of them hanging strands the process
  *after* it prints "Shutting down" — SIGTERM received, exit never comes, port stays bound. A
  clean shutdown is ~10ms even holding a managed llama-server and serving a connected client, and
  it was caught hanging **once** (10s and counting, mid-drive) and has not reproduced since,
  which is what a race looks like and why it must not be chased one await at a time. Nothing here
  is worth hanging for: SQLite commits per statement, Pi sessions are append-only, the
  llama-server child is detached *on purpose* for pid-file adoption, and a client whose SSE
  stream dies reattaches on its own. A second signal exits immediately rather than queueing a
  second graceful shutdown behind the stuck one.
- Cache GGUF metadata by the file's blob oid, never by repo, commit, path or
  mtime. `recordModelProps` is the single place a successful `/props` is
  recorded: it takes `raw.model_path`, `realpath`s it, keeps the basename when it
  is a 64-hex sha256, writes it to `model_cache.model_oid`, and re-reads the
  header only when that oid moves. A path outside a content-addressed cache has
  no oid, so nothing is cached; a header that will not parse is a missing detail,
  never a failed turn. llama.cpp hands the child `--hf-repo`, so it re-resolves the repo and
  re-downloads on *every* model load; a chat-template fix lands without Nelle
  being told. The commit sha is not the file: this repository's HF cache holds two
  snapshots of `unsloth/gemma-4-26B-A4B-it-qat-GGUF` whose GGUF symlinks point at
  the same blob. The blob's name is its sha256, the same value the API reports as
  `lfs.oid`, and Nelle gets it free by taking `realpath` of `/props`
  `raw.model_path`. Compare it after every load; re-parse only when it moves.
- Nelle works offline once a model is downloaded, and that is a property of the
  design rather than a mode: every fact about an installed model comes from the
  local blob and from `/props`. Hugging Face is needed to browse, and for the
  trained context window of a model never loaded.
- **Deleting a model can reclaim its weights — but a repository is shared by every quant of
  it.** `DELETE /api/models/:id?weights=1` removes the Hugging Face repo directory (only
  possible, and only *safe*, because the cache is Nelle's now: in the user's global
  `~/.cache/huggingface/hub` those blobs are shared with every other HF tool). But a repo
  directory holds **all** of that repo's quants, so two models on one `repoId` — two quants,
  or a **duplicate** — share one pile of blobs, and deleting the directory would silently
  destroy a working model's weights. The route therefore keeps them and answers
  `sharedWithModelIds`, naming the models that held them; a client must render that rather
  than claim a reclaim that never happened. `ConfiguredModel.diskBytes` is the repo's size,
  `null` when nothing is downloaded (the weights arrive on the **first load**) or when the
  user pointed llama.cpp at a cache of their own. **`diskBytes` and `pinned` answer different
  questions**: weights can be on disk while the pin is not set, because Nelle only pins on a
  *successful load* — conflating them told a model with 4.8 GB on disk that it was "not
  downloaded yet".
- **A downloaded model is pinned to its weights, and that is what makes the sentence
  above true.** llama.cpp re-resolves `hf-repo` against Hugging Face on **every** load,
  and its cache fallback (`common_download_get_hf_plan`) fires **only when the repo
  listing comes back empty**. Measured against a real load, with a fake Hugging Face:
  - repo **deleted**, gated, or unreachable → the listing is empty → falls back to the
    cache → **loads fine** (it pays a failed round trip, and logs an `E` line that is not
    a failure -- worth knowing before the M7 log screen scares someone).
  - repo **still exists but dropped your quant** (a re-upload, a rename, a prune -- which
    publishers do routinely) → the listing *succeeds*, the tag is not in it,
    `find_best_model` returns nothing, and llama-server exits with
    **`failed to load model ''`** while the weights sit intact on disk. The router does not
    even mark it `failed`; it silently stays `unloaded`, so a run grinds to its timeout and
    reports a bare `model_load_failed`.

  So `ConfiguredModel.pinned` (`offline = 1` in the section) is written **the moment a
  model has loaded once** -- a successful load is proof its blobs are complete, and it is
  the only moment pinning is both safe and possible. It **cannot be a default**: `offline`
  also means *never download*, so a fresh import would have nothing to fetch with. The
  preset is written but the router is *not* reloaded -- the running instance already holds
  its resolved args, so a reload would only restart a model that is working.

  `pinned: false` via `PATCH /api/models/:id` lets the next load re-check Hugging Face, so
  an upstream fix (a corrected chat template, a re-quant) can land; it re-pins itself once
  that load succeeds. An update is therefore a deliberate act, not a standing exposure.
  **`offline` is a field, not a param**: it is in `RESERVED_MODEL_KEYS` and refused by the
  params validator, because Nelle writes it -- a user who deleted the row would watch it
  come straight back, which is the fight `stop-timeout` used to pick.
- **Nelle does not own the model download, and this was reconsidered, not assumed.**
  llama.cpp's downloader **resumes** (it HEADs for `Accept-Ranges` and sends
  `Range: bytes=<n>-`), etag-caches, fetches shards in parallel, and auto-discovers *and
  wires* the accessories -- `mmproj` → `params.mmproj.path`, the MTP head →
  `params.speculative.draft` (that is speculative decoding, free). It writes the
  content-addressed HF layout that `model_cache.model_oid` depends on, and it already
  streams `download_progress` on the router SSE. Owning it would mean reimplementing repo
  listing, commit resolution, file selection, shard collection, and **`find_best_sibling`'s
  mmproj/MTP pairing rules** (deepest shared directory, then closest quant bit-width) --
  rules llama.cpp owns, which is the exact drift that produced the MTP quant-picker bug.
  It is *expressible* if we ever want it (`model`, `mmproj` and `spec-draft-model` are all
  in the option catalogue, so local absolute paths would work), and the one thing it would
  buy is a background download queue that does not load the weights into RAM. But it is not
  needed for correctness: the pin above closes that hole for ~20 lines instead of ~500.
- GGUF metadata has three sources, and the cheapest that answers wins. The search
  takes `architecture`, `context_length` and the parameter count from
  `expand[]=gguf` on the *list* endpoint -- one request, no extra cost -- and the
  per-repo request that follows exists only for file sizes, which need
  `?blobs=true` and which used to come back `null` for every file.
  `gguf.totalFileSize` is the size of the one file Hugging Face parsed, not a
  repo total and not a per-quant size; do not display it as either.
  `@huggingface/gguf` is a detail view, never a search result: it parses the
  local blob in ~1.5 s (`computeParametersCount` costs nothing extra, and is the
  only way to know gemma-4-26B's 25.2B parameters, which its header does not
  declare). It is **server-only**, like `pdfjs-dist`: a client never parses a GGUF
  header, it reads the answer off `GET /api/models`.
- **Which GGUF files in a repo are *models* is llama.cpp's decision, not Nelle's.**
  `isModelGguf` (`huggingface.ts`) is a deliberate port of `gguf_filename_is_model`
  (`common/download.cpp`): three substrings -- `mmproj`, `imatrix`, `mtp-` -- tested
  against the **basename**, **case-sensitively**. llama.cpp is what downloads the
  file, and `find_best_model` applies that rule *before* it matches the quant tag, so
  a file it rejects can never be reached by `hf-repo = <repo>:<TAG>` however the tag
  is spelled. Offering one anyway does not yield a broken model -- it yields one that
  imports cleanly, sits in the catalog looking ordinary, and can **never load**, with
  the reason in llama-server's log and nowhere a user will look. (It was live:
  `unsloth/gemma-4-26B-A4B-it-qat-GGUF` offered five quants, four of which were MTP
  heads.) The three exclusions are not junk -- they are **accessories** llama.cpp
  fetches *alongside* the chosen model (`find_best_mmproj`, `find_best_mtp`), so
  offering one as a quant offers the accessory instead of the thing. Keep it a
  faithful port and **do not lowercase it**: repos exist whose names carry an
  uppercase `MTP` (`unsloth/Qwen3.6-35B-A3B-MTP-GGUF`), and a case-folding filter
  would sit one naming convention away from emptying a whole catalog. Hugging Face
  publishes no per-file classification -- no endpoint, no sibling field, nothing in
  `@huggingface/gguf` -- so this convention is the only contract there is. Update it
  from llama.cpp's source, never by adding a guess. A quant legitimately spanning
  several files is **sharding** (`...-00001-of-00002.gguf`), which llama.cpp resolves
  through `get_split_files`; summing those sizes is correct, and any filter that
  deduplicated to one file per quant would break it.
- `/props` `default_generation_settings.n_ctx` is the per-conversation window --
  with `kv_unified = true` each of the four slots sees the whole thing -- and it
  is cached in `model_cache.context_window`. The router also reports
  `raw.meta.n_ctx_train`, the model's trained window, once it has loaded it;
  that is cached in `model_cache.context_train` and both are served on
  `GET /api/llama/models` so Settings can say "Full window: 262,144 · running at
  32,768" without a client re-deriving either from `raw`.
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
- Any harness that boots a server must pin `NELLE_LLAMA_PORT` away from 8080
  (`scripts/serve-fixture.ts` uses `18081`). The runtime status probe treats any
  healthy server on the configured port as a running llama.cpp, so a suite left on
  the default adopts a developer's real llama-server.
- Do not reintroduce local GGUF path registration or Nelle-owned model downloads
  in the active product; model imports are Hugging Face `hf-repo` entries.
- Nelle persists managed llama-server ownership in
  `.nelle/llama/llama-server.pid.json` so restarted servers can adopt and stop
  the prior router process.
- **Installing llama.cpp is a *build*, not a request, so it is streamed.**
  `POST /api/runtime/install/stream` (and `/update/stream`, the same handler) answers
  SSE with `RuntimeInstallEvent`: `runtime.install.started` (carrying `installMode`),
  `runtime.install.output` (**the build's own stdout/stderr, line by line**),
  and a terminal `runtime.install.completed` (a `RuntimeStatus`) or
  `runtime.install.failed` (a `NelleError`). On Linux an install is a `git clone` plus a
  full cmake compile -- **measured at ~3 min with a warm ccache and CUDA, and much longer
  cold** -- so the streaming route is the *only* one: the non-streaming
  `POST /api/runtime/install` / `/update` pair is **gone**, and must not come back. It
  failed three ways at once: the user watched a silent spinner, the build's output was
  buffered and discarded, and any client with a receive timeout reported failure while the
  build carried happily on server-side.
  - `runCommandStreaming` (`process.ts`) is the streaming twin of `runCommand`, and it
    **throws with the exit code only**: the output has already been delivered, and
    `runCommand`'s habit of packing the whole stderr into one `Error` message would put a
    megabyte of cmake diagnostics inside a JSON error field.
  - **`stderr` is not failure.** cmake and git narrate progress there. A client must not
    paint it red -- the same trap as llama-server's log, where a *successful* offline load
    of a pinned model writes an `E` line. (A real build: 820 stdout lines, 2 stderr, and it
    succeeded.)
  - **Order is guaranteed *within* a stream and never *between* them.** The two pipes are
    drained concurrently, and even in a terminal stdout is block-buffered to a pipe while
    stderr is unbuffered, so faithful interleaving does not exist anywhere. Render two
    ordered streams; never claim a global order.
  - A second install while one is running is refused with `runtime_install_in_progress`.
    That is not an exotic race: the button shows nothing for minutes, so clicking it twice
    is the obvious thing to do, and two builds would `rm -rf` each other's `build/`.
  - **You cannot overwrite a running executable on Linux**, and *updating* llama.cpp means
    doing exactly that. The kernel refuses with **`ETXTBSY`** ("text file is busy"), and the
    same goes for a shared library a live process has mapped -- so an update with
    llama-server running compiled to 100% and then died on the very last step, after a full
    build. It had always been broken and was **invisible**: the old non-streaming route
    buffered the output and discarded it, and no client rendered the error. Found by driving
    the real app.
    `replaceRunningFile` **unlinks before copying** -- unlinking a running binary *is* allowed
    (the process keeps its inode and carries on with the old code until it is restarted, which
    is also exactly the semantics wanted). `copySharedLibraries` had the same bug and
    **swallowed the error**, which is worse: a new binary beside stale `.so` files.
- A client uses Nelle's `/api/llama/*` router facade for llama.cpp props, models,
  load/unload, reload, model props, and router events. Nothing talks to llama.cpp
  directly: it is Nelle's child process, on a port Nelle chose, and only Nelle knows
  whether it is up and which of its models it configured.
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
- `conversations.updated_at` is the sidebar's sort key *and* its keyset cursor,
  so only activity may stamp it, and a read never may.
  `replaceConversationProjection` bumps it when Pi's leaf moved -- the session
  file is append-only, so a moved leaf is a gained entry -- and leaves it alone
  otherwise. Opening a conversation rebuilds its projection on the read path, and
  stamping it there sent whichever chat the user last opened to the top of the
  list, one click behind. The `ready` a stale `running` row recovers to after a
  restart, and the variant groups a metadata-less rebuild rediscovers, are not
  activity either. Runs bump it through `setConversationStatus` at their start
  and end, so a conversation being answered rises on its own, and so does the
  chat whose answer just landed.
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
  should prefer its own. `canRepair` stays true until a repair or rebuild
  succeeds.
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
- Chat streaming uses `/api/conversations/:id/chat/stream`. The legacy
  `/api/chat/stream` and `/api/chat/messages` endpoints have been removed, and
  `syncLegacyDefaultConversationFromState` runs only at startup and from the
  direct-llama fallback -- never from a read path. Pi no longer mirrors messages
  into `state.json.chat[]`; only `directLlama` writes it, because the fallback
  runs when Pi is unavailable and has no session file to persist into.
- Implement conversation fork/duplicate through Pi
  `SessionManager.createBranchedSession()`, creating a new Nelle conversation
  for the new Pi session file, copying retained Nelle sidecar metadata, and
  leaving the source conversation unchanged.
- A client reads commands and snapshots over REST and takes runs as SSE streams of
  typed Nelle event envelopes. Stop/abort calls Pi `AgentSession.abort()`; Nelle's
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
  names, and the Flutter client's `ChatStreamEvent.fromEnvelope` accepts both.
- `run.warning` carries `{code, message, detail?}`, not bare prose. The codes live
  in `NELLE_WARNING_CODES`. A UI can render a sentence, but nothing can branch on
  one, localize it, or suppress a warning it already knows about.
- `conversation.forked` is specified by the router plan but deliberately not in
  the union: fork and clone are plain JSON routes and Nelle has no
  conversation-level SSE channel, only per-run streams. Add it with that channel,
  not before.
- Stream `error` events must carry stable `NelleError` fields (`code`,
  `message`, optional `detail`/`retryable`/`logRef`); do not emit message-only
  errors from new server stream paths. Every code lives in `NELLE_ERROR_CODES`
  (`apps/server/src/contracts/contracts.ts`); add new ones there so a second client can
  know what it may see.
- The chat route enforces the same three guards as the composer, because
  enforcing them only in a client leaves every other client able to bypass
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
- Reasoning budgets are global and are the **`reasoning` settings group**
  (`GET`/`PATCH /api/settings/reasoning`, three number fields defaulting to llama.cpp's
  own 512/2048/8192). `piHarness` reads them from `SettingsRepository` and they reach
  llama.cpp as the top-level `thinking_budget_tokens` field, injected through Pi's
  `agent.onPayload` hook. They lived in `state.json` until M6; they render themselves from
  the served schema now, like every other group.
  Pi's own `thinkingBudgets` setting never reaches an OpenAI-completions
  provider, and neither `reasoning_budget` nor
  `chat_template_kwargs.thinking_budget` has any per-request effect. The `max`
  level and a budget of `0` both mean "send no budget".
- Conversation snapshots carry `messages` as well as `entries`. `messages` is
  what a client renders, built by `buildConversationMessages`
  (`apps/server/src/contracts/messages.ts`): it hides user turns a regenerate replayed,
  drops contentless assistant entries that ran no tools and produced no
  reasoning, groups regenerate variants by
  `displayGroupId ?? regeneratesPiEntryId ?? id` and labels them `variant N/M`,
  and joins attachments by `piEntryId`. `entries` stays for a future branch
  explorer; nothing in a normal client should read it. It is a *shared* helper and
  not a client's, precisely so no client re-derives any of that.
- **`apps/server/src/contracts/` is the wire contract, and it has ZERO runtime import cycles. Keep
  it that way.** `attachmentMetadata.ts` exists for exactly one reason, and it is *not* the retired
  web bundle: `conversations.ts` runtime-imports `messages.ts`, while `messages.ts` imports
  `conversations.ts` **type-only** (erased). Both — and `streamEvents.ts` — runtime-import the
  metadata schema. Fold it into `conversations.ts` and `messages.ts` must runtime-import
  `conversations.ts`, closing a **real** cycle — and zod schemas in a cycle die on TDZ
  (`Cannot access 'X' before initialization`), at import time, for every consumer. The split is
  load-bearing. Verify with an import-graph check, not by reading the comment.
- `apps/server/src/contracts/attachments.ts` holds the limits and happens to be
  zod-free; `attachmentMetadata.ts` exists so `conversations.ts` and `messages.ts`
  can both import the metadata schema at runtime without becoming circular.
- Preferences that should follow the user live in the `settings` table under the
  `preferences` key and are served by `GET`/`PATCH /api/settings/preferences`. Since M6
  that is **favourite model ids and nothing else**: a favourite is a *set*, and the
  settings registry has no field type for one, which is exactly why it stays hand-written.
  The six display toggles moved *out* of here and into the `display` settings group, where
  they render themselves (`apps/server/src/contracts/displayPreferences.ts` still owns their
  keys, labels and help, and the group is generated from it). Do not put either back into
  device-local storage: they follow the *user*, and a favourite that lives on one machine
  is not a favourite. A favorite for a model missing from `models.ini`
  is filtered from the response, never deleted from storage. `updatePreferences`
  merges over the *raw* stored row, so a key this build does not know -- one a
  newer client wrote -- survives; reads narrow field by field, so one malformed
  toggle falls back to its own default and takes no sibling with it. Only the
  *storage* is server-side: the client still decides what a collapsed thinking
  block looks like -- a client-local rendering concern (see the server-vs-client
  boundary rule below). Toggling is optimistic and has no Save button, and
  reverts if the server
  refuses. Genuinely client-local state -- sidebar collapse, open settings
  section, search text, drafts -- stays in the client.
- A settings draft is what the user is typing, so only the save that made it
  stale may overwrite it. A catalog or snapshot refresh must never re-seed drafts:
  it may add and drop whole models, but it may not rewrite a field the user has a
  cursor in (the Flutter param editor's `Map.hashCode` trap above is this bug in
  another shape). Seed once on load; each save resets from the values the server
  answered with.
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
  Section headers and any chat count must render `total`, not the number of rows
  paged in.
- Model param update payloads are full replacements for editable params in a
  section. Preserve a free-form key by including it in the submitted key/value
  draft; omit it to delete it.
- **Nelle writes no llama.cpp defaults into a `models.ini` section.** A section
  carries `hf-repo`, `alias`, and whatever the *user* put there -- nothing else, so a
  freshly imported model has an empty param list, which is the honest answer: it runs
  on llama.cpp's defaults. It used to stamp `stop-timeout = 10` into every section,
  which is *precisely* llama.cpp's own default (`DEFAULT_STOP_TIMEOUT`,
  `tools/server/server-models.cpp`; `apply_stop_timeout()` only overrides it when the
  preset carries the key). It bought nothing and cost two real things: a mystery row
  in every model's parameter editor, and the one key a full replacement could not
  delete -- omit it and Nelle wrote it straight back. Restating a default to its owner
  is never worth that, so do not reintroduce one.
- **`ModelParams` reads and writes in two different shapes, and it is not
  guessable.** `GET /api/models` answers
  `params: {contextSize?, extra: Record<string,string>}` -- where `contextSize` is a
  *read-only prediction* derived from the `[*]`-plus-section cascade, and **absent is
  the normal case** (it means no cap, so llama.cpp auto-fits). `PATCH /api/models/:id`
  takes `params` as a **flat `Record<string,string>`** that *replaces* `extra`
  wholesale. So a client that round-trips the GET object straight back into the PATCH
  is refused with a 400. Edit `params.extra`; send it flat. (`gpuLayers`, `threads`
  and `batchSize` used to sit in this type and were **never populated by anything** --
  a promise the contract made and never kept, which is worse than a missing field
  because a client renders a control for it. They are gone; a GPU-offload or thread
  setting is just a key in `extra`, like every other llama.cpp lever.)
- **Every `models.ini` catalog mutation answers with the whole catalog**
  (`ModelCatalog`: `{models, activeModelId, globalModelParams}`, the same shape
  `GET /api/models` serves), and a client **applies it** rather than patching the row
  it touched. It has to: activate, duplicate and delete all move `activeModelId` --
  a duplicate *becomes* the active model and deleting the active one promotes a
  neighbour -- and editing `[*]` rewrites the derived `contextSize` of **every** model
  at once. This replaced an echo of the server's entire `AppState`, which dragged the
  legacy 100-message `chat[]` and llama.cpp's host/port along on every response and
  which no client ever read. **`AppState` is server-internal**: `GET /api/state` is
  gone with the browser that used it, and `tests/unit/openapi.test.ts` fails if the
  type reaches the contract again.
- The composer model selector is compact but router-aware: it is searchable,
  groups the user's favourites first, shows selected/row router
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
  **Every** path that loads a model must do it, and for a while only the chat run did:
  a model loaded from *Settings* sat there `loaded` with no architecture, no context
  window and its capabilities unknown, for ever. `cacheModelPropsAfterLoad` is the one
  place; call it from any new load path.
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
  `{"model":"<id>","event":"status_change","data":{"status":"loading","progress":
{"stages":["text_model","mmproj_model"],"current":"text_model","value":0.77}}}`;
  the model id is a top-level string, not a field inside `data`.
- A load runs **one stage per sub-model** -- a vision model loads `text_model`
  and then `mmproj_model` -- and `value` restarts at 0 for each, so `value` alone
  is not the load's progress: it fills the bar, snaps back to zero and fills it
  again. Progress is `(stageIndex + value) / stages.length`, which is monotonic,
  and that collapse is `routerLoadProgress` (`apps/server/src/contracts/routerProgress.ts`).
  llama.cpp also emits a bare `{"stage":"mmproj_model"}` between stages --
  singular `stage`, no `value` -- which announces a stage rather than measuring
  one, so it must leave progress alone rather than reset it. `undefined` means
  "loading, amount unknown" and is never zero: a client shows the placeholder
  without a number rather than inventing a 0% the server never sent. Progress
  belongs to the `loading` status and must be dropped when the load ends, or a
  loaded model keeps the last percentage it reported and shows it again on its
  next load.
- **llama.cpp publishes load progress only on `/models/sse`.** Its `/models` list
  answers `status: {value, args, preset}` and has never carried a number, so a
  poll-based wait can say `loading` and nothing else -- which is why
  `model.loading.progress` sat empty on the wire while the field existed.
  `ensureModelRunnable` therefore *follows* the router stream for the life of the
  load (`watchModelLoadProgress`) and merges it into the events it emits, so the
  percentage is server truth that every client gets for free. A client must not
  have to open a second SSE stream and correlate it with the run just to show a
  number.
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
  `regenerates_pi_entry_id` / `display_group_id` sidecar metadata. The transcript
  preserves existing answer variants, hides replayed duplicate user turns, and
  labels visible assistant variants in the footer.
- A regenerated-away answer survives **only** in
  `conversation_entry_projection`. It is off the active branch, so `getBranch()`
  never returns it again, and `replaceConversationProjection` deletes every row
  and rewrites it from the entries it is handed -- so `prependVariantEntry` must
  carry *every* field of a preserved variant, not just the ones a transcript
  happens to show. It dropped `reasoning`, and so a regenerate silently destroyed
  the thinking of the answer it branched from, then wrote that loss back over the
  only copy of it. Adding a field to the projection means adding it there too.
- The slash-command allowlist lives in `apps/server/src/contracts/commands.ts` and is
  served by `GET /api/commands`; it currently exposes only `/compact`. The chat
  route's `assertSupportedSlashCommand` and the composer render the same refusal
  through `unsupportedSlashCommandMessage`, so allowlisting a command needs no
  client release. The client prefers the fetched registry and falls back to the
  bundled one only until that request resolves. Unsupported slash commands must
  be blocked client-side with composer status guidance and must not be sent to Pi
  as prompts.
- Assistant performance metadata should render as a toggleable Reading
  (prompt processing) / Generation (token output) stats widget with icon
  controls, not as a plain text throughput string.
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
- Keep the workbench viewport-bounded: the sidebar and the chat history scroll
  internally while the composer stays docked. Opening a conversation pins the
  transcript to its newest message, re-measuring until the height settles and
  releasing on the user's first scroll input.
- Composer attachments are text files, PDFs, and images only. Gate images on
  selected-model `modalities.vision`; do not expose audio/video attachments while
  Pi's structured input path is text plus image.
- There is no PDF rendering switch. The server reads a PDF's text when it has a
  text layer and renders its pages when it has not, because only the server knows
  both the document and the model. `POST /api/uploads` reports `hasTextLayer` so
  a chip can say which; a scan is refused at upload only for a model llama.cpp
  has *proven* has no vision. Refusing a scan for want of extractable text made
  the one document that needs page images the one document Nelle would not take.
- The attachment drawer renders only when something is attached.
- `resolveChatAttachments` refuses a message whose images Pi could not leave room
  to answer, naming the pages, the tokens, the window, and the context size that
  would fit. `maxAffordableImages` deliberately ignores conversation history and
  uses the *measured* `PI_AGENT_PROMPT_TOKENS`, which varies by a few hundred, so
  it can only let through a message that then reports `reply_budget_exhausted` --
  never refuse one that would have worked.
- A message the server refused before it became a turn (no `run.started`) must
  leave the composer draft intact. The uploads are still on the server, unbound,
  and making the user retype the prompt and pick the files again is not a fix.
- Attachments are uploaded, not embedded. The client posts bytes to
  `POST /api/uploads` (**`multipart/form-data`**: a `file`, plus an optional
  `conversationId`); the server classifies them, rejects a binary file posing
  as text, extracts PDF text with `pdfjs-dist`, and answers with an `uploadId`
  (`uploadResponseSchema` -- whose `warnings[]` is how the user learns the image
  was downscaled or the text truncated, and whose `hasTextLayer: false` means a
  scan). A chat request carries `attachments: [{uploadId}]` and **nothing else**
  -- there is no `renderPdfAsImages`, because there is no rendering switch (see
  the PDF bullet above), and `chatAttachmentReferenceSchema` is `.strict()`, so an
  old client embedding `text`, `data`, or a rendering mode is told so instead of
  having its bytes stripped. Both the reference and the upload response are served
  in the OpenAPI; `ChatAttachmentInput` deliberately is **not** -- it is the
  server's post-resolution type, a client never sends it, and serving it only got
  one codegened into the Flutter client. `resolveChatAttachments` expands a PDF into page images through
  `@napi-rs/canvas` at send time, which is why the per-message limits are checked
  after the expansion. Sent payloads still land content-addressed under
  `.nelle/attachments/`, with metadata bound to the Pi user entry.
- **Reading a PDF and parsing a GGUF header are the server's work, and stay there.**
  `pdfjs-dist` (with `@napi-rs/canvas` supplying the canvas its page renderer needs) and
  `@huggingface/gguf` are `apps/server` dependencies: they parse bytes with Bun/Node APIs
  no client has, which is exactly why `POST /api/uploads` takes the file and answers with
  a classification rather than asking a client to do any of it. **Keep them out of
  `contracts/`**, which is the wire contract and the pure helpers over it — a schema module that
  drags in a native canvas is a schema module no one can reason about.
  (`tests/unit/webBundle.test.ts` used to pin this by failing if either reached the browser bundle;
  the bundle is gone, the boundary is not.)
- Draft uploads live under `.nelle/uploads/<uploadId>/` and in the `uploads`
  table, apart from the content-addressed `.nelle/attachments/` tree. An unbound
  upload older than 24h is swept at startup and hourly; a bound one belongs to a
  message and goes only with its conversation. Removing a chip in the composer
  deletes its upload rather than waiting for the sweep.
- Deleting a conversation has no confirmation dialog; it hides the row at once
  and holds the request for a 5s undo window, and the client must hide
  pending-deleted ids so a list refresh cannot resurrect them. Once the request
  lands it is irreversible, which the undo copy says. (See the M8 client bullet
  for the rest of the reasoning.)
- Conversation hard delete removes the deleted conversation's Pi session file
  and only unreferenced attachment files. Server startup also sweeps orphan
  files under `.nelle/attachments/` that are absent from SQLite attachment
  metadata. Keep file cleanup constrained to Nelle-owned data/session
  directories.
- Conversation export/import uses local `.nelle-chat.zip` archives with
  manifest checksums, the Pi session JSONL, Nelle sidecar metadata, referenced
  attachment files, model snapshots, and `tool-audit.jsonl` rows when host tools
  were used. Imports always create a new conversation.
- **`apps/client` (Milestone 8: the conversation lifecycle).** Search, pin, rename, fork,
  clone, export, import, repair, rebuild, diagnostics -- every route the server already had
  and no client but the browser used.
  - **Export cannot save a file on a phone**, and this is what the packages implement, not a
    preference. `file_selector_android` has exactly three methods (`openFile`, `openFiles`,
    `getDirectoryPath`); `getSaveLocation` exists on linux/windows/macOS/web and **nowhere
    else**, where the platform interface's default throws `UnimplementedError`. (`getDirectoryPath`
    is no way round it: on Android it returns a SAF content URI, which `dart:io` cannot write
    to.) So `ArchiveService` splits -- a Save dialog on the desktop, the **OS share sheet**
    (`share_plus`) on mobile, which is the only thing that actually reaches a phone's storage.
    Import is uniform (`openFiles`, SAF picker on Android). `share_plus` is plain platform
    channels: no `irondash`, no cargokit, so it is not the `super_clipboard` trap.
  - **`POST /api/conversations/import` is NOT multipart**, unlike `/api/uploads`: it reads the
    zip straight off `ctx.req.arrayBuffer()`, so a multipart envelope gets `invalid_archive_upload`.
    And **export answers bytes while a *failed* export answers JSON** -- dio needs
    `ResponseType.bytes` up front, so the error body arrives as unreadable bytes unless it is
    decoded (`sendBytes`), and the user gets "Request failed" for a refusal the server explained
    in a sentence. The archive's filename comes off `content-disposition`; the server already
    slugged it, and a client re-deriving it would invent a second name for the same file.
  - **Fork and clone are different acts in different places.** A **fork** branches at one of the
    *user's* messages (a transcript footer action, gated on `capabilities.canFork`) -- there is
    nothing to fork from the model's answer, and regenerate is what belongs there. A **clone**
    duplicates the whole conversation (a sidebar action, no `entryId`). Both refuse the
    impossible with **`conversation_not_branchable`** and a 409: an empty conversation has a
    header-only Pi session and nothing to branch from, and both used to be a bare 500. A branched
    conversation must *say* so (`forkKind`), because a fork's transcript looks like an ordinary
    chat that begins mid-thought, and the user needs to know the original still exists.
  - **`archive_session_missing` is a distinct refusal, not "your file is corrupt".** Exporting an
    `unavailable` conversation is allowed on purpose -- you must be able to salvage a broken chat
    -- and the manifest records `piSessionMissing`. Importing it is refused, but the zip is
    perfectly *valid*; it simply carries no history. The import route hard-coded `invalid_archive`
    for every failure and threw the specific code away, leaving it in `NELLE_ERROR_CODES` as
    something nothing ever emitted.
  - **Delete is held, not undone.** The server's delete is irreversible the moment it lands (the
    Pi session file, and every attachment nothing else references), so the request is simply not
    *sent* for five seconds and the row is hidden -- and hidden from a refresh too, or a list
    reload inside the window resurrects it. No confirmation dialog: it taxes the ninety-nine
    deliberate deletes to catch the one mistake, and the undo catches it for free. (The browser's
    `pagehide` + `keepalive` machinery is a *browser* problem -- a reload cancelling the request --
    and has no equivalent here.)
  - **The unavailable conversation is not an empty one.** The Pi session JSONL *is* the history;
    SQLite holds a projection. A broken chat rendered as an ordinary empty chat with a working
    composer told the user their conversation was gone when it was recoverable. Three explicit
    exits: **repair** (lossless, and therefore offered first -- it only succeeds if the user put
    the file back, because it never invents a session), **rebuild** (lossy, and the UI must *name*
    what it destroys: tool results, image content, compaction summaries, regenerate variants --
    "this is lossy" is not a choice a user can weigh), and delete. The reason line is the
    *filesystem's own*, from `GET /diagnostics`. A repair or rebuild must also **refresh the
    sidebar**: the list row carries `status` and does not re-fetch on its own.
  - **Search is a server query**, and the loaded page is a window onto the list -- filtering it
    client-side reports "no matching chats" for every conversation the user has not scrolled to.
    The query rides into `loadMore`, or page two pages them out of their own results. Debounced
    *and* token-guarded: a debounce narrows the race and does not close it, and a slow early
    answer landing last leaves the box saying one thing and the list showing another.
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
- The context thresholds live in `apps/server/src/contracts/context.ts`
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
- `/compact [instructions]` is implemented with Pi `AgentSession.compact()`;
  compaction stop uses `AgentSession.abortCompaction()`. Do not send
  `/compact` through normal prompt submission.
- The composer has exactly **one** send affordance. Auxiliary controls (attach,
  model, reasoning) never grow into a second one.
- **Server vs. client boundary.** A rule the client owns is a rule the *next* client
  reimplements. There is one client today (`apps/client`) and the contract is public
  (`GET /api/openapi.json`), so that is a statement about the future, not about
  today's convenience -- the last client to hold these rules took them to the grave
  with it. Before adding logic to `apps/client`, ask: does it need server data or
  CPU, or does it change the shape of what gets rendered? Then it belongs on the
  server, where every client gets it for free. Rendering, drafts, optimistic UI,
  scroll, and live run state stay in the client, as does `canAbort`/`canCompact`,
  which the client tracks more freshly than any payload can carry.
  `apps/server/src/contracts/` is TypeScript the server shares with *itself* (contracts, zod
  schemas, pure helpers); no client imports it.
- **Settings scope is settled**, so do not reopen it by accident: Pi owns the
  agent loop and the context, `max_tokens` must never be advertised to Pi, and
  PDF-as-image was removed on purpose. The settings schema is served from
  `GET /api/settings/schema`, the way `GET /api/commands` serves the
  slash-command registry, so a second client renders it without a copy of the
  copy.
- **The settings schema is itself a served contract.** `SettingsField` is a discriminated
  union on `type` (`text` | `textarea` | `number` | `boolean` | `select`), and the
  TypeScript types are `z.infer`red from the zod schemas so the document and the registry
  cannot drift. The Dart model is **hand-written** (`lib/src/api/settings_schema.dart`),
  like `ChatStreamEvent` and for a sharper reason: swagger_parser turns the `oneOf` into
  `SettingsFieldSealedVariant1..5` and deserializes by *trying each variant until one does
  not throw* -- and `text` and `textarea` carry identical keys apart from the `type`
  literal, so a textarea comes back as a text field, silently, putting 8,000 characters of
  custom instructions in a one-line box. An unknown `type` becomes `UnknownSettingsField`
  and renders as *nothing*, so a newer server never breaks an older client's settings
  screen.
- **Seven groups, one renderer, and it must stay that way.** `instructions`,
  `attachments`, `titles`, `reasoning`, `display`, `runtime`, `network` all render from
  `GET /api/settings/schema` with **no client code that knows what any of them mean** --
  labels, help, bounds, options and defaults all arrive from the server, so a new setting
  ships without a client release. The moment a client special-cases `maxImageMegapixels`,
  the schema has been thrown away. Reasoning budgets, the runtime limits and the six
  display toggles were *moved into* the registry to make this true; the `runtime` group is
  where `--models-max` and `--sleep-idle-seconds` come from.
- **`SettingsSection`/`SettingsField` is a *rendering* contract, not "the server's data".**
  The Flutter client describes its **device-local** sections (Appearance, and Notifications
  when it lands) with the *same types* and draws them with the *same widget*, behind a
  `SettingsSource` (`ServerSettingsSource` over HTTP, `DeviceSettingsSource` over
  SharedPreferences). A setting is device-local when applying it to another device would be
  wrong or impossible: `System` theme resolves against *that* OS, a notification permission
  is granted per device, and the server connection *is* this device's relationship to a
  server. Everything else follows the user. If a device setting ever needs its own UI, the
  renderer is wrong.
- **Two things are deliberately *not* settings**, and knowing why is what keeps the renderer
  generic. **Host tools** are an acknowledgement *gate* on an unsandboxed shell -- the
  registry can express a boolean but not "this one may only be turned on after you have read
  something" -- and the server *enforces* it (`enabled` without `acknowledged` is refused).
  **Favourites** are a *set*, and the registry has no field type for one. Both are custom
  screens; custom is the escape hatch, never the default.
- **A refused save keeps the draft and names the field.** `PATCH /api/settings/<slug>` is
  `.strict()` and zod-validated, and the refusal carries the offending key in
  `error.detail` -- so the client shows the server's own sentence *under that control*, not
  at the bottom of a nine-field form. Only touched fields are sent: a save must not rewrite
  a value the user never looked at.
- A server setting exists in exactly one place: `SETTINGS_REGISTRY` in
  `apps/server/src/contracts/settings.ts`. The served schema and the zod schema
  `PATCH /api/settings/<slug>` validates against are both *derived* from it, so
  they cannot drift; do not hand-write a zod object beside a field. Routes are
  registered by iterating the registry, which is why `schema`, `preferences` and
  `host-tools` are never swallowed by a `:group` parameter, and why a slug
  collision fails loudly at boot. Field keys are a contract like
  `NELLE_ERROR_CODES`: renaming one breaks a client that stored it, and there is
  no migration path through a phone's cache. `PATCH` is `.strict()`, so an
  undeclared key is refused *by name*; a key already in the row is therefore one
  a newer build wrote, and `SettingsRepository.updateGroup` writes it back
  untouched rather than eating a setting the user would lose on the way back up.
  Reads coerce field by field, so one unreadable value falls back to its default
  alone and takes no sibling with it.
- A paste longer than `attachments.pasteToFileCharacters` (default 2,500; `0`
  disables) becomes a `.txt` upload instead of forty thousand characters in the
  input. The client owns the event because only it has one; the threshold and the
  ingestion are the server's, and until `GET /api/settings/attachments` answers,
  the client has no threshold and every paste stays in the message -- it must not
  carry a copy of the default.
- Settings a client *acts* on are the **saved values**, never the drafts: a
  half-typed threshold is not in force until it is saved.
- `apps/server/src/contracts/settingsKeys.ts` holds the group slugs and the field keys
  that are branched on. It is zod-free, and `settings.ts` imports it too, so the
  names exist once. It holds names, never defaults.
- Conversation titles are a setting (`GET`/`PATCH /api/settings/titles`), and the
  pure helpers live in `apps/server/src/contracts/titles.ts`.
  `streamConversationTitleIfNeeded` is the only path that runs; it fires once per
  conversation, on the first exchange of a chat still at `titleSource:
'fallback'`. `maxWords` is *enforced* by truncation, not merely requested in the
  prompt, because a model ignores being asked. `renderTitlePrompt` substitutes
  `{{USER}}`, `{{ASSISTANT}}` and `{{MAX_WORDS}}` in one pass, so a user message
  containing the literal text `{{ASSISTANT}}` reaches the model as that text.
  The trigger needs one user turn and at most one assistant turn: a turn the
  model answered with nothing is still titled from the user's first line, and
  `llm` skips the round trip when there is no reply to summarize. (An answerless
  turn is usually the reply-budget clamp, not a spent reasoning budget: see
  `PI_MINIMUM_CONTEXT_TOKENS`.) Title
  generation sets its own `temperature: 0.2` because it bypasses Pi and so never
  sees `models.ini` sampling; the system message is not user-editable because it
  states the output format Nelle parses.
- `models.ini` keys are validated against the binary, never against a list Nelle
  carries. `LlamaOptionCatalogueCache` parses `llama-server --help` once per
  binary (keyed by path, size and mtime) and serves it from
  `GET /api/llama/params`. The accept-set is the union of every argument spelling
  with its *leading* dashes stripped and every env var name, exactly as
  `common/preset.cpp`'s `get_map_key_opt` builds it -- so `c`, `ctx-size` and
  `LLAMA_ARG_CTX_SIZE` are all the same option. It is **case-sensitive**: `-c` is
  `--ctx-size` and `-C` is `--cpu-mask`, so a duplicate check must compare
  trimmed keys, never lowercased ones. Two keys are `set_preset_only()` in
  `common/arg.cpp` and never appear in `--help` -- `stop-timeout` and
  `load-on-startup` -- so `PRESET_ONLY_KEYS` carries them: a catalogue read from
  `--help` alone would reject a key llama-server is perfectly happy with, and tell
  the user their valid parameter is a typo. Help text that parses to nothing is `available:
false`, which *skips* the unknown-key check: refusing to save a parameter
  because Nelle could not run a binary is worse than the typo. Validation reports
  every bad key at once as `invalidParams: [{key, reason, message, suggestion?}]`
  beside a single top-level `error.code`, and the client joins them to rows by
  `key` -- never by row id, so an edit to one row cannot unmark another.
- Sampling belongs to the model, not to Pi's requests. Pi sends no sampling
  parameters at all, so llama.cpp's launch flags are what every conversation
  runs with: `models.ini` carries `temp`, `top-k`, `min-p`, `seed` and the rest,
  with `[*]` as the global default and a `[model]` section overriding it. An
  unrecognized key there is fatal -- llama-server refuses to start with
  `option '...' not recognized in preset` -- while a bad *value* only fails the
  model load, so validate keys and do not guess at values.
- gemma's vision encoder saturates near 0.8 MP (104/208/282/282/276 prompt tokens
  from 0.2 to 6.0 MP), so `attachments.maxImageMegapixels` saves bytes and prompt
  processing, not context tokens. It defaults to `0` (off), because on gemma it
  buys no context and a silent quality loss is a bad default; other encoders tile
  rather than saturate, so the saving is a property of the model. An image
  already under the cap is never re-encoded -- re-encoding a JPEG at quality 90
  twice is a real quality loss for no gain -- and a downscale says so in a
  warning. Rendered PDF pages take the smaller of the cap and
  `MAX_RENDERED_EDGE_PX`.
