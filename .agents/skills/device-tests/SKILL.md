---
name: device-tests
description: Write, run, and debug Nelle's Flutter integration_test device suite (bun run test:device / test:device:slow) against the real server fixture. Use when adding a regression device test, running the suite on desktop or the Android emulator, or when a device test fails mysteriously — silent enterText no-ops, pumpAndSettle races, off-screen taps, mutated fixtures, or Pi sessions that will not continue.
---

# The device suite

The device suite runs the **real** app (`main()`, real providers, real dio, real
HTTP) against a **real Nelle server** — `scripts/serve-fixture.ts`, on a
throwaway `.nelle-device`, port 8797, with `NELLE_LLAMA_PORT=18081` so it can
never adopt the developer's llama-server. Two tiers:

- **`bun run test:device`** (fast, ~7 min) — llama.cpp **stopped**, which is
  what a fresh install is and where most error paths live. One entrypoint
  (`integration_test/app_test.dart`) calling suite functions, because **multiple
  `integration_test` files fail on Linux** ("Unable to start the app on the
  device").
- **`bun run test:device:slow`** (~2 min, on demand) — a **real gemma-4-E2B**
  really generating: a chat app whose chatting is never tested end to end has a
  hole in the middle, and stubbing llama.cpp would test nothing. Model setup:
  see the `model-testing` skill.

## The phone tier

The same fast tier runs on the phone — `bun run test:device -- -d
emulator-5554`, against a headless emulator (flags in the `driving-the-client`
skill). It needs no pairing, no TLS, no pin: `adb reverse tcp:8797 tcp:8797`
maps the emulator's loopback to the host's port, so the fixture's _trusted_
listener answers — deliberate, because pairing is covered by `devices.test.ts`
and three client test files, and a TLS handshake plus a Keystore write in every
device test would be testing the harness.

Run the suite on both desktop and phone, because the phone finds what the
desktop hides: it immediately caught a test asserting a forked-from conversation
was "still in the sidebar" — below the 760px breakpoint the chat **replaces**
the list (`workbench_screen.dart`), so the check failed on a layout behaving
perfectly. **Assert the claim, not a proxy visible on a 1280px window** — "the
original is unchanged" is a fact about the server, so ask the server.

## The traps (each cost a debugging session)

- **`pumpAndSettle` does not wait for network I/O.** It settles _frames_, and an
  HTTP response schedules none until it lands — so it returns mid-request, and
  `expect(finder, findsNothing)` then passes **vacuously**. Assert presence with
  `pumpUntil`, never a bare `pumpAndSettle`. (Widget tests never meet this:
  `stubDio` answers synchronously.) `launchApp` follows the same rule and waits
  for the server-backed conversation count; startup is not a special case.
- **A presence barrier is only as honest as its scope.** After a mutation, bare
  text can still match the editor or an exiting dialog before the server answers.
  Wait for the text under the authoritative widget instead — for example, the
  renamed title beneath `k-conv-tile-<id>` — so a slower runner cannot satisfy the
  barrier with the value the user merely typed.
- **Cancel provider-owned HTTP as well as SSE on disposal.** The router model
  provider can be torn down while its initial list request is still in flight
  (the device suite replaces the real app between tests). Its list and stream
  each own a `CancelToken`, and cancellation during disposal completes quietly;
  otherwise a slower platform reports a network exception after the test or
  screen already ended.
- **Image fixtures must survive the real decoder.** A PNG signature is not
  enough: chunk lengths and CRCs must be valid, and a preview test pumps the
  codec to completion and checks `takeException()`. Image decoding is
  asynchronous, so a malformed fixture is often blamed on the following test
  instead of the test that rendered it.
- **A finder matches off-screen widgets**, and `tap()` at off-screen coordinates
  hits nothing, _silently_. Use `tapAt` (which `ensureVisible`s first).
  `tester.pageBack()` is useless here: it looks for a Material/Cupertino back
  button and this app is forui over a bare `FScaffold`.
- **A lazy `ListView` never builds a row that is far off-screen, so _waiting_
  for it cannot work.** `tapAt` scrolls first (`scrollUntilVisible`), then
  waits. Invisible on a tall desktop window; fatal on a phone, on Windows, and
  on any shorter viewport.
- **`tester.enterText` is a silent no-op on a field that is not focused** — the
  most expensive trap in the suite. It does not throw or warn; the failure
  surfaces wherever the _consequence_ was expected, nowhere near the line that
  broke. The first `enterText` usually works (nothing has focus yet); the second
  often does not (a completed run rebuilds the composer and the text-input
  connection goes stale). Use `typeInto`, which taps the field first and
  **verifies the text landed**.
- **The seeded fixtures are read-only.** Every test drives the same server, in
  one process, in order, so a test that renames a seeded conversation breaks the
  next one that looks for it by name. A mutating test calls
  `createOwnConversation()` and uses the **id** it answers — never a title
  lookup, because the server generates a title from the first exchange
  (fire-and-forget, so it is a race too).
- **A hand-seeded Pi session can be READ but not CONTINUED.** Entries written
  with `SessionManager.appendMessage` replay fine, but Pi's agent then completes
  with no text. Only a session Pi itself created (`POST /api/conversations`) can
  be chatted with — the slow tier brings its own conversations, and the "empty"
  fixture is created through the API too (`SessionManager.create()` allocates a
  path without writing a file).
- Only **one binding** may exist, so `main.dart` guards on
  `BindingBase.debugBindingType() == null` before initializing
  `MarionetteBinding` — otherwise it collides with
  `IntegrationTestWidgetsFlutterBinding`.
