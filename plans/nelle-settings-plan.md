# Nelle Settings Plan

Last updated: 2026-07-10

## Purpose

llama.cpp's own web UI exposes 45 settings across seven sections. Most of them
are theirs to expose because they own the whole stack; Nelle does not. Pi owns
the agent loop, the context, the tool calls, and the session file, and fighting
it for those knobs would buy complexity and nothing else.

A handful, though, are things Nelle already does badly or not at all: it
generates conversation titles with a prompt nobody can see or change, and it
gives the user no way to tell the model who they are.

This plan takes the settings worth taking, says plainly why the rest are skipped,
and puts every one of them on the server. A setting whose rule lives in the
browser is a setting the React Native and desktop clients reimplement.

## Two Decisions Already Made

1. **The settings schema is served.** `GET /api/settings/schema` returns the
   fields — key, label, help, type, default, bounds — the way `GET /api/commands`
   already serves the slash-command registry. A second client renders the
   settings UI without rewriting fifteen fields of copy, and a new setting ships
   without a client release.
2. **Sampling parameters do not go through Pi's requests.** They are
   model-dependent, so they belong to the model, and `models.ini` already carries
   them. See "Sampling belongs to the model" below, which is the measurement that
   makes this work.

## Where Each Setting Lives

Following `plans/nelle-thin-client-plan.md`:

- **A rule the server enforces** — the system prompt, the title prompt, the image
  cap — lives in the `settings` table and is applied server-side. A client sends
  what the user typed and never re-derives anything.
- **A preference the client applies** — whether the stats widget starts open,
  whether the transcript auto-scrolls — lives in the `settings` table too, under
  the `preferences` key, because it should follow the user to their phone. The
  _applying_ stays in the client; only the storage moves.
- **A property of the model** — temperature, top-k, min-p, seed — lives in
  `models.ini`, per section, with `[*]` as the global default. Nelle already
  writes that file losslessly.
- **Genuinely local state** — sidebar collapse, open settings section, drafts —
  stays in the browser stores, as it does today.

## Evidence: What llama.cpp Exposes

Read at `ee445f9`, `tools/ui/src/lib/constants/settings-registry.ts`.

### Taken

| Setting                                                              | Their default                                | Why it is worth having                                                           |
| -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| System Message                                                       | `''`                                         | Nelle gives the user no way to say who they are or how the model should answer.  |
| Use LLM to generate conversation title                               | `false`                                      | Nelle does this **unconditionally** and offers no way off.                       |
| LLM title generation prompt                                          | a template with `{{USER}}` / `{{ASSISTANT}}` | Nelle's title prompt is hardcoded in `piHarness.ts:1718`.                        |
| Use first non-empty line for title                                   | `false`                                      | A title without a model round trip, which works while llama.cpp is stopped.      |
| Paste long text to file length                                       | `2500`                                       | Fits the upload flow Nelle already has; a 40k-character paste belongs in a file. |
| Maximum image resolution                                             | `0` (off)                                    | Bounded value — see the measurement below.                                       |
| Display toggles (stats, thinking, tool calls, markdown, auto-scroll) | various                                      | Cheap, and they should follow the user rather than the browser profile.          |

### Skipped, and why

- **Sampling parameters, penalties, and Custom JSON.** Not through Pi's requests.
  Temperature that suits one model ruins another, so the knob belongs beside the
  model, and `models.ini` already holds it — verified below. Injecting it into
  every request instead would put one global number in front of every model the
  router can load. Custom JSON existed only as the escape hatch for the exotic
  samplers (XTC, DRY, dynatemp, typical-p, sampler order); `models.ini` reaches
  all of them already, so the hatch is redundant and the deny-list it would have
  needed is one fewer thing to get wrong.
- **Max tokens.** `AGENTS.md` is explicit: never advertise a fixed `maxTokens` to
  Pi. Pi clamps it against the live context, and an override would silently
  reintroduce the one-word-answer bug that `packages/shared/src/piContext.ts`
  exists to prevent. Not in requests, and not in `models.ini` either — llama.cpp
  would apply it as a server-side cap Pi cannot see.
- **API key.** llama.cpp is local and unauthenticated. Nothing to key.
- **Parse PDF as image.** Deliberately removed on 2026-07-10: the server decides
  from the document. See `plans/nelle-thin-client-plan.md`, Phase 1.
- **Agentic max turns, max tool preview lines.** Pi owns the agent loop.
- **Pre-encode conversation, disable reasoning parsing, exclude reasoning from
  context, raw output toggle.** Pi owns the context and Nelle depends on
  `reasoning_content` being parsed. `exclude reasoning from context` is the only
  tempting one; it needs a Pi primitive that does not exist yet.
- **JS sandbox, Python interpreter, MCP servers, MCP timeout.** Pi has its own
  tool and MCP story. Nelle's host tools are already gated behind an
  acknowledgement.
- **Custom CSS, build version, model tags, quantization, raw model names,
  microphone on empty input, full-height code blocks, always-show sidebar.**
  Presentation trivia or not applicable.
- **Ask for confirmation before changing conversation title.** Nelle never
  renames a conversation behind the user's back, so there is nothing to confirm.
- **Enable "Continue" button.** Needs a Pi continue primitive. Revisit if Pi
  grows one.

## Sampling Belongs To The Model

Three facts, each checked rather than assumed, and together they say the whole
thing:

**Pi sends no sampling parameters at all.** None of `temperature`, `top_p`,
`top_k`, `min_p` or `repeat_penalty` appears anywhere in
`@earendil-works/pi-coding-agent/dist`, and the single hit for `seed` is inside a
bundled copy of highlight.js. So the request never overrides anything.

**`models.ini` accepts them, and llama.cpp applies them.** `common/preset.cpp`'s
`get_map_key_opt` maps every option by its environment variable _and_ by each of
its argument spellings with the dashes stripped, so `temp`, `top-k`, `min-p` and
`seed` are all valid keys. Confirmed against the real binary: a preset carrying
them loads and the server reports `Available models`. Because Pi sends no
sampling fields, those launch flags are exactly what every conversation runs
with. `[*]` gives a global default and a `[model]` section overrides it — which
is precisely the shape the knob wants, and it costs no new storage.

**An unknown key is fatal; a bad value is not.** A typo is refused at startup:

```
$ llama-server --models-preset bad.ini
E srv llama_server: failed to initialize router models:
      option 'temprature' not recognized in preset 'demo'
```

llama-server exits, and Nelle's runtime never comes up. A _bad value_ is milder:
`temp = not-a-number` parses fine and the server starts, because the option's
callback does not run until the model instance is spawned. So the fatal case is
the one a settings editor invites, and Nelle's
`validateEditableParams` (`server.ts:1261`) checks syntax and reserved keys but
never asks whether the key is real. Routing sampling through `models.ini` makes
that gap much easier to hit, which is why Phase 3 exists.

## Image Resolution Is Not A Token Lever

Sending one generated PNG through `/v1/chat/completions` at five sizes:

| Image     | Megapixels | `prompt_tokens` |
| --------- | ---------- | --------------- |
| 512×384   | 0.20       | 104             |
| 768×576   | 0.44       | 208             |
| 1024×768  | 0.79       | 282             |
| 2048×1536 | 3.15       | 282             |
| 3000×2000 | 6.00       | 276             |

gemma's vision encoder saturates around 0.8 MP: a six-megapixel photo costs the
same context as a one-megapixel one. So "Maximum image resolution" buys smaller
uploads and less prompt-processing work, **not** context. It is worth having —
a 12 MP phone photo is several megabytes of base64 across two hops — but it must
not be sold as a way to fit more images in the window, and it must default to
off. Other vision encoders tile rather than saturate, so the setting's value is
model-dependent; the help text should say so.

## Phase 0: One Place For Server Settings, And A Served Schema

Nelle's settings are scattered: `state.json` holds runtime and reasoning budgets,
the `settings` table holds `hostTools` and `preferences`, `models.ini` holds
per-model llama.cpp launch flags, and `conversations.reasoning_level` is per
conversation. Nothing here proposes moving what exists. It proposes not adding a
fifth home.

- New behaviour settings live in the `settings` table under typed keys, behind a
  `SettingsRepository` shaped like `PreferencesRepository`
  (`apps/server/src/preferences.ts`), which is the pattern that already works.
- Shared zod schemas in `packages/shared/src/settings.ts`, with the defaults as
  exported constants. The client never carries a second copy of a default; the
  server returns effective values. This is the rule that
  `plans/nelle-thin-client-plan.md` Phase 0c exists to enforce.
- Routes follow the shape already in use: `GET`/`PATCH /api/settings/<group>`.

```http
GET   /api/settings/instructions   -> {customInstructions: string}
PATCH /api/settings/instructions

GET   /api/settings/titles         -> {mode, prompt, maxWords}
PATCH /api/settings/titles

GET   /api/settings/attachments    -> {pasteToFileCharacters, maxImageMegapixels}
PATCH /api/settings/attachments
```

`GET`/`PATCH /api/settings/preferences` already exists and grows the display
toggles.

### The schema is served

```http
GET /api/settings/schema
  -> {sections: [{slug, title, fields: [
       {key, label, help, type: 'text'|'textarea'|'number'|'boolean'|'select',
        default, min?, max?, step?, options?}]}]}
```

The registry is one exported constant in `packages/shared/src/settings.ts`, and
the same constant is what the zod schemas and the server's validation are built
from. There is then exactly one place a setting exists, and a client that renders
the schema gets every future field for free.

The bespoke sections — Runtime, Models, Reasoning, Tools, Chats — stay
hand-built. They are not fields; they are surfaces with their own affordances.
The schema drives a new **General** section and grows the display toggles.

Field keys are a contract the way `NELLE_ERROR_CODES` is. Renaming one breaks a
client that stored it, and there is no migration path through a phone's cache.

**Tests.** The schema's field keys match the zod schemas' keys exactly (a drift
guard: adding a field to one without the other fails); every field's `default`
parses against its own schema; `PATCH` rejects a key absent from the registry
with `invalid_request` naming it.

## Phase 1: Conversation Titles

The smallest phase, entirely server-side, and it fixes a real gap: Nelle
generates a title with a prompt nobody can read, and if llama.cpp is down or slow
the conversation stays "New chat" forever.

Today: `PiHarness.maybeGenerateConversationTitle` fires whenever `titleSource`
is `fallback` and the conversation has exactly one user and one assistant
message. It POSTs a hardcoded system+user prompt with `max_tokens: 24`,
`temperature: 0.2`, an 8-second timeout, and gives up silently on failure.

Target:

```ts
type TitleSettings = {
  /** How a conversation earns its title. */
  mode: 'llm' | 'first-line' | 'off';
  /** `{{USER}}` and `{{ASSISTANT}}` are substituted. Ignored unless mode is 'llm'. */
  prompt: string;
  maxWords: number;
};
```

- `mode` defaults to `'llm'`, which is what Nelle does now. llama.cpp defaults
  their equivalent to off; changing Nelle's behaviour by default would be a
  regression dressed as a setting.
- `'first-line'` takes the first non-empty line of the user's message, trimmed to
  `maxWords`. No model, no round trip, works while llama.cpp is stopped.
- `'llm'` falls back to `'first-line'` when the request fails or times out,
  rather than leaving "New chat" behind. This is strictly better than today.
- The prompt template is rendered server-side. Substitution is literal and the
  result is capped; `sanitizeGeneratedTitle` already strips quotes and prefixes.
- Title generation keeps its own `temperature: 0.2`, sent explicitly, because it
  bypasses Pi and talks to `/chat/completions` directly. It therefore ignores the
  model's `models.ini` sampling defaults, which is correct: a creative
  temperature makes bad titles. Say so in a comment, because the next reader will
  wonder why one code path sets temperature and the other never does.

**Tests.** `{{USER}}`/`{{ASSISTANT}}` substitution including a message that
itself contains `{{USER}}`; `first-line` on a message whose first line is blank,
and on one that is 400 characters long; `llm` falling back to `first-line` when
the fetch rejects; `off` leaving `titleSource` at `fallback`; and that a
conversation the user renamed is never retitled.

## Phase 2: Custom Instructions

llama.cpp calls it "System Message" and lets it replace the prompt. Nelle must
not: `piHarness.ts:1194` already overrides Pi's system prompt with Nelle's own,
which tells the model whether host tools are enabled and that they run
unsandboxed. Replacing that with user text would delete a safety statement.

So the user's text is **appended**, through Pi's own mechanism:

```ts
new DefaultResourceLoader({
  cwd,
  agentDir,
  systemPromptOverride: () => nelleOperationalPrompt(toolsEnabled),
  appendSystemPromptOverride: () => [customInstructions].filter(Boolean),
});
```

- The system prompt is baked at session construction, so a change must call
  `pi.resetSession()` — the same thing `PATCH /api/settings/host-tools` already
  does. A cached session for an open conversation picks the new prompt up on its
  next turn.
- Global only, in this phase. A per-conversation override is a natural follow-up
  and would live beside `conversations.reasoning_level`.
- Cap the text (say 8k characters) and warn in the UI what it costs: Pi's own
  system prompt already measures ~9,400 tokens of its context estimate, and a
  long instruction block eats the reply budget. Reuse the arithmetic in
  `packages/shared/src/piContext.ts` to show the cost as the user types.

**Tests.** The operational prompt survives the append; an empty setting appends
nothing (not an empty string); saving resets cached sessions; the appended text
reaches `session.systemPrompt`; and the character cap is enforced server-side,
not only in the browser.

## Phase 3: Make Model Params Safe

This phase exists because sampling now lives in `models.ini`, and one typo there
stops llama.cpp from starting at all.

- **Validate keys against llama.cpp's own option list.** `llama-server --help`
  prints all 252 options with every spelling; parse it once per binary, cache it
  against the binary's path and mtime, and expose it as
  `GET /api/llama/params -> {options: [{key, aliases, help, type}]}`. The
  catalogue is served, so a settings UI can offer completion and a client does
  not carry a copy of llama.cpp's argument list that goes stale on upgrade.
- `validateEditableParams` gains an unknown-key check that fails with
  `invalid_model_param`, names the key, and suggests the nearest match. It must
  accept short spellings: `c` is `--ctx-size`, and Nelle's own `models.ini`
  already uses it.
- **Do not** try to validate values. `temp = not-a-number` starts the server
  quite happily and fails later at model load, where the router already reports
  `failed` and Nelle already surfaces it. Guessing each option's type from
  `--help` would be a second, worse copy of llama.cpp's parser.
- The Models settings section gets a short, curated hint listing the sampling
  keys people actually want — `temp`, `top-k`, `top-p`, `min-p`, `seed`,
  `repeat-penalty` — with `[*]` explained as the global default. Discoverability
  is the whole reason this is not simply "type whatever you like".

**Tests.** An unknown key is refused before `models.ini` is written; a short
spelling is accepted; the catalogue parses from a captured `--help` fixture, so
the test does not need the binary; a stale cache is invalidated when the binary
changes; and `models.ini` is never written when validation fails.

## Phase 4: Display Preferences

Pure storage relocation. Each becomes a key under `preferences`, defaulting to
today's behaviour, and the browser reads it instead of a hardcoded constant:

- `showGenerationStats` — the Reading/Generation widget's initial state.
- `showThinkingInProgress` — whether a live reasoning block is expanded.
- `showToolCallsInProgress`.
- `renderUserContentAsMarkdown`.
- `renderThinkingAsMarkdown`.
- `disableAutoScroll` — read by `useScrollChatToBottomOnOpen`.

Favourites already live here. Nothing new is invented; the list grows.

**Tests.** Extend `tests/unit/preferences.test.ts`: an unknown key round-trips
untouched (so an older server does not eat a newer client's preference), and a
malformed row falls back to defaults rather than throwing.

## Phase 5: Paste Long Text To A File

The composer catches a paste of more than `pasteToFileCharacters` characters
(default 2500, `0` disables) and posts it to `POST /api/uploads` as a `.txt`
instead of dropping 40,000 characters into the input.

The client keeps the paste event, because only it has one. The threshold and the
ingestion are already server-side; this phase is mostly wiring, and it is the
cheapest real improvement in this plan.

**Tests.** e2e: paste 3,000 characters, see a chip and an empty composer; paste
2,000, see them in the composer; set the threshold to `0` and paste 100,000,
see them in the composer.

## Phase 6: Maximum Image Resolution

Downscale on upload, in `ingestUpload`, with `@napi-rs/canvas` — already a
dependency for PDF rendering. Default `0` (off), because on gemma it buys nothing
in context (see the measurement above) and a silent quality loss is a bad
default.

The help text must say what it actually does: fewer bytes over the wire and less
prompt-processing work, with token savings that depend on the model's vision
encoder. Nelle knows the model's modalities from `model_cache`; it does not know
whether that encoder tiles or saturates, and it should not pretend to.

Rendered PDF pages already cap at 1600px on the long edge
(`MAX_RENDERED_EDGE_PX`); this setting should apply to them too, taking the
smaller of the two.

**Tests.** A 3000×2000 upload comes back within the cap and stays a valid PNG;
`0` leaves the bytes untouched byte-for-byte; an image already under the cap is
not re-encoded (re-encoding a JPEG at quality 90 twice is a real quality loss for
no gain).

## Sequencing

1. **Phase 0** — the registry, the repository, the served schema. Everything else
   is a field.
2. **Phase 1 (titles)** — self-contained, server-only, fixes a real gap, and
   proves the settings plumbing on something small.
3. **Phase 3 (model param safety)** — before anyone is encouraged to type
   `temp` into the params editor and take llama.cpp down with a typo.
4. **Phase 5 (paste to file)** — cheapest user-visible win.
5. **Phase 2 (custom instructions)** — the one people ask for.
6. **Phase 4 (display preferences)** — mechanical.
7. **Phase 6 (image cap)** — optional, and honest about being optional.

## Risks

- **Changing the system prompt invalidates llama.cpp's KV cache** for every open
  conversation, and Pi's cached sessions must be reset. Expect the next turn
  after a save to reprocess the whole prompt. Say so in the UI.
- **An unknown `models.ini` key is fatal to llama-server.** Phase 3 is what
  stands between the params editor and a runtime that will not start. Until it
  lands, the params editor is sharper than it looks.
- **`seed` in `models.ini` makes a run reproducible only if nothing else moves.**
  A different context or prompt changes the output. Do not promise determinism.
- **Sampling defaults apply to the agent loop, not to title generation.** Two
  code paths reach llama.cpp; only one of them is a conversation, and the title
  path sets its own temperature on purpose.
- **A settings schema served over HTTP is a contract.** Renaming a key breaks a
  client that stored it. Treat `SETTINGS_KEYS` the way `NELLE_ERROR_CODES` is
  treated.
