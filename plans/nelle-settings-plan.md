# Nelle Settings Plan

Last updated: 2026-07-10

## Purpose

llama.cpp's own web UI exposes 45 settings across seven sections. Most of them
are theirs to expose because they own the whole stack; Nelle does not. Pi owns
the agent loop, the context, the tool calls, and the session file, and fighting
it for those knobs would buy complexity and nothing else.

A handful, though, are things Nelle already does badly or not at all: it
generates conversation titles with a prompt nobody can see or change, it gives
the user no way to tell the model who they are, and it caps every model at 16,384
tokens of context — six percent of what gemma-4-26B was trained for — while
telling Pi that number as though llama.cpp had said it.

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
- **A property of the model** — temperature, top-k, min-p, seed, and the context
  cap — lives in `models.ini`, per section, with `[*]` as the global default.
  Nelle already writes that file losslessly. What the model _actually_ runs with
  is llama.cpp's to report, not Nelle's to assume: the context window comes back
  from `/props` and everything computes from that.
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

## The Context Window Is llama.cpp's To Report

Nelle invents a context window and tells nobody who could correct it.

**llama.cpp already defaults to the model's own window.** `-c, --ctx-size N` is
`(default: 0, 0 = loaded from model)`. Nelle overrides it with `c = 16384` in
`models.ini`'s `[*]` section (`store.ts:49`), which is not llama.cpp's default —
it is ours, added because Pi's system prompt plus its 4,096-token reserve made an
8k window useless.

**The models we ship against want far more.** The router reports both numbers
once it has loaded a model, on `GET /api/llama/models` as `raw.meta`:

| Model           | `n_ctx` (ours) | `n_ctx_train` (the model's) |
| --------------- | -------------- | --------------------------- |
| gemma-4-26B-A4B | 16,384         | 262,144                     |
| Qwen3.6-35B-A3B | 16,384         | 262,144                     |
| tinygemma3      | 8,192          | 131,072                     |

Nelle caps every one of them at six percent of the window it was trained for, and
then passes `raw.meta` through to clients without ever reading it.

**`/props` reports the effective window per conversation.**
`default_generation_settings.n_ctx` is 16,384, and the log confirms
`n_slots = 4, n_ctx_slot = 16384, kv_unified = 'true'` — with a unified KV cache
each slot sees the whole window, so the number in `/props` is the number a
conversation actually gets. Nelle already parses it into
`LlamaModelProps.contextWindow` and caches it in `model_cache.context_window`.
Nothing reads it for arithmetic.

**Pi is told Nelle's number, not llama.cpp's.** `writePiModels`
(`piHarness.ts:1766`) sets `contextWindow: model.params.contextSize`, and
`contextSizeFromParams` (`store.ts:528`) derives that from the `c` or `ctx-size`
key with a hardcoded 16,384 fallback. Today the two agree by construction. The
moment `c` stops being written, that fallback becomes a lie: Pi would clamp
`max_tokens` against 16,384 while llama.cpp ran a 262,144-token window, the
context bar would call a 20k prompt an overflow, and the image budget would
refuse a message that fits ten times over.

**A per-model `c` already overrides `[*]`.** Verified against the real binary:
`ctx_preset.cascade` applies the global section and then the model's. So a
per-model cap needs no new storage — it is a key in the section Nelle already
writes.

**The memory is the reason to allow a cap.** The KV cache scales linearly with
the context, so a 262,144-token window wants sixteen times the KV allocation of
today's 16,384, and llama.cpp asks for all of it at load. A machine that cannot
give it gets a model that will not load. That is the user's trade to make, not
ours to make for them silently.

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

## Phase 3: Validate Model Params, And Say Which Field Is Wrong

This phase exists because sampling now lives in `models.ini`, and one typo there
stops llama.cpp from starting at all. It covers **both** editors: the global
`[*]` params (`PATCH /api/models/global-params`) and the per-model params
(`PATCH /api/models/:id`). They already share `validateEditableParams`
(`server.ts:1261`), which is where the check belongs.

### What counts as a valid key

`common/preset.cpp`'s `get_map_key_opt` maps every option by **each of its
argument spellings with the dashes stripped**, and by **each of its environment
variable names**. All four of these are therefore valid, and all four were
confirmed against the real binary:

```ini
c = 16384                 # short spelling of --ctx-size, and what Nelle writes today
ctx-size = 16384          # long spelling
n-predict = 128           # a second long spelling of --predict
LLAMA_ARG_TOP_K = 40      # the environment variable name
```

The accept-set is therefore the union of every spelling and every env name, not
just the canonical long option. A validator that only knows `ctx-size` would
reject Nelle's own `models.ini`.

### The catalogue is served, not carried

`llama-server --help` prints 252 options across four sections
(`----- common params -----`, `sampling`, `speculative`, `example-specific`).
Parse it once per binary and cache against the binary's path, size and mtime.

The format, from the real output:

```
-h,    --help, --usage                  print usage and exit
-c,    --ctx-size N                     size of the prompt context (default: 0, ...)
-n,    --predict, --n-predict N         number of tokens to predict (default: -1, ...)
--cpu-strict <0|1>                      use strict CPU placement (default: 0)
-t,    --threads N                      number of CPU threads to use during generation
                                        (env: LLAMA_ARG_THREADS)
```

An entry starts at column 0 with a dash. Spellings are comma-separated; the
token after the last spelling, if it does not start with a dash, is the value
hint (`N`, `M`, `<0|1>`, `<0...100>`). Description and `(env: NAME)` arrive as
continuation lines indented to the description column — 127 of the 252 options
carry one.

```http
GET /api/llama/params
  -> {available: true,
      options: [{keys: ['c', 'ctx-size'], env: ['LLAMA_ARG_CTX_SIZE'],
                 valueHint: 'N', help: 'size of the prompt context', section: 'common'}]}
```

Served, so a settings UI can offer completion and a client never carries a copy
of llama.cpp's argument list that goes stale on the next upgrade.

**When the catalogue is unavailable** — no binary installed, an external binary
that will not run, `--help` exits non-zero — the response is
`{available: false, options: []}` and the unknown-key check is **skipped**.
Syntax, reserved keys and duplicates are still enforced. Refusing to save a
parameter because Nelle could not run a binary would be worse than the typo.

### The error names the field

Today `validateEditableParams` returns the first problem as one sentence, and the
dialog shows one line of red text for a form with ten rows. A client cannot tell
which row is wrong, so it cannot mark it, and the next client would have to guess
the same way. The server knows exactly which keys failed and what each should
probably have been, so it says so:

```jsonc
400 {
  "error": {
    "code": "invalid_model_param",
    "message": "2 parameters are not llama.cpp options.",
    "retryable": false
  },
  "invalidParams": [
    {"key": "temprature", "reason": "unknown", "message": "…is not a llama.cpp option.",
     "suggestion": "temperature"},
    {"key": "tpo-k", "reason": "unknown", "message": "…is not a llama.cpp option.",
     "suggestion": "top-k"}
  ]
}
```

- `reason` is one of `unknown | reserved | duplicate | syntax`, so a client can
  branch without parsing prose. The existing `reserved_model_param` and
  `duplicate_model_param` codes fold into it as reasons; the route keeps
  returning a single top-level `code` for clients that only read that.
- `suggestion` is the nearest key by edit distance, and only when it is close
  enough to be worth offering. The distance function lives in
  `packages/shared/src/modelParams.ts`, zod-free, so a client could use it for
  live completion later without a round trip.
- **Every** invalid parameter is reported, not just the first. A form with three
  typos should light up three rows on one save, not on three.

The composer for this is the existing `KeyValueEditor` in `SettingsDialog.tsx`:
each row's key input gets an error state and the message beneath it, plus a
"Did you mean `temperature`?" affordance that fills the field on click. The rows
are already keyed by a stable `id`, and `invalidParams` is keyed by `key`, so the
join is trivial. The client renders; it does not decide.

### What we deliberately do not validate

`temp = not-a-number` starts llama-server quite happily: the option's callback
does not run until the model instance is spawned, so the failure is contained and
the router already reports the model as `failed`, which Nelle already surfaces.
Guessing each option's type from a `--help` value hint would be a second, worse
copy of llama.cpp's parser, and it would reject values llama.cpp accepts.

The Models settings section also gets a short, curated hint listing the sampling
keys people actually want — `temp`, `top-k`, `top-p`, `min-p`, `seed`,
`repeat-penalty` — with `[*]` explained as the global default. Discoverability is
the whole reason this is not simply "type whatever you like".

**Tests.** The parser reads `tests/fixtures/llama-server-help.txt` — 647 lines
captured from llama.cpp `ee445f9`, checked in so the test never needs the binary
— and finds `c`, `ctx-size`, `n-predict`, and `LLAMA_ARG_TOP_K`; an unknown key is refused before `models.ini` is written, on
both routes; three typos produce three `invalidParams`; `suggestion` is absent
when nothing is close; a missing binary yields `available: false` and lets any
key through; a stale cache is invalidated when the binary's mtime changes; and an
e2e that types `temprature`, saves, and sees that row marked with the suggestion.

## Phase 4: Stop Inventing A Context Window

Nelle stops writing `c`, llama.cpp uses the model's own window, the user may cap
it, and every number Nelle computes comes from what llama.cpp reports back.

### The effective window, resolved once

```ts
/** What a conversation on this model actually gets, or `null` while unknown. */
function effectiveContextWindow(modelId: string): number | null {
  return modelCache.getContextWindow(modelId) ?? configuredContextCap(modelId) ?? null;
}
```

- `model_cache.context_window` is llama.cpp's own `/props` answer and always
  wins. It is already written on every successful props fetch, including the one
  the server performs after it loads a model for a run.
- The configured cap is the `c` key — global in `[*]`, per-model in the model's
  section, the latter overriding the former, which is llama.cpp's own cascade.
  It is only a _prediction_ of what llama.cpp will do; once loaded, `/props` is
  the truth.
- `null` means "never loaded and never capped". It is an honest answer and must
  be handled as one, not papered over with a constant.

Every current reader of `model.params.contextSize` moves to it:
`writePiModels` (`piHarness.ts:1766`), the reply-budget warning
(`piHarness.ts:781`), the live context tracker (`piHarness.ts:764`,
`directLlama.ts:78`), the snapshot's context total (`piHarness.ts:530` and
`conversations.ts`), and the image budget (`server.ts:954`).

### What `null` means at each call site

- **The context bar** shows usage with no total. `contextUsageStatus` already
  returns `ok` when `totalTokens` is missing, so the bar stays plain rather than
  claiming a percentage it cannot know.
- **The image pre-flight** is skipped. `maxAffordableImages` needs a window; with
  none, no message is refused up front, and the run-time
  `reply_budget_exhausted` error still catches a payload Pi cannot answer within.
  Refusing on a guess would be the one thing worse than not refusing.
- **Pi must never see `null`.** It bakes `contextWindow` into the session at
  construction. The chat and regenerate routes already call
  `ensureModelReadyForRun` — which loads the model and caches its props — before
  `createChatStream`, so by the time `ensureSession` runs the window is known.
  Make that an invariant with an assertion rather than a comment, because the
  other two callers (title generation, the direct-llama fallback) do not load
  first and must supply the cap or bail.

### Sessions are rebuilt when the window changes

Pi reads `contextWindow` from `.pi/models.json` at session creation and clamps
against it for the session's life. Changing the cap, or loading a model for the
first time and learning its real window, must call `pi.resetSession()` — the
same thing `PATCH /api/settings/host-tools` already does. Otherwise a session
created before the first load keeps clamping against a number nobody believes.

### The full window becomes visible

`model_cache` gains `context_train`, read from the router's `raw.meta.n_ctx_train`
on `GET /api/llama/models`, which Nelle already receives and discards. Settings →
Models can then say **"Full window: 262,144 · running at 16,384"**, and a cap can
be validated against it instead of accepted blindly.

`n_ctx_train` is only known after a model has been loaded once. Before that the
UI says "the model's full window" and means it.

### Migrating installs that already have `c = 16384`

`[*] c = 16384` is written into every existing `models.ini` by Nelle, not by the
user. But a user who deliberately typed `16384` is indistinguishable from Nelle
having typed it, so the migration is narrow and stated plainly:

- Remove `c` from `[*]` **only if its value is exactly the old default**, once,
  recorded in `state.json` so it never runs twice.
- Any other value is the user's and is left alone.
- `DEFAULT_STATE.globalModelParams` becomes `{}` and `DEFAULT_PARAMS.contextSize`
  disappears. `contextSizeFromParams`'s 16,384 fallback goes with it; there is no
  fallback, only `null`.

### Two things to verify before building

- **What llama.cpp says when the KV cache will not fit.** The model fails to
  load; Nelle already reports `model_load_failed`. Whether the message names
  memory, and whether the failure is distinguishable from any other load failure,
  is unverified. If it is, the error should suggest capping `c`; if it is not,
  the error should say so rather than guess.
- **`contextSizeFromParams` reads only `c` and `ctx-size`.** After Phase 3 a user
  can legitimately write `LLAMA_ARG_CTX_SIZE`, which llama.cpp accepts and Nelle
  would ignore. The catalogue from Phase 3 supplies the alias set; use it, which
  is a good reason to land Phase 3 first.

**Tests.** `/props` beats the configured cap; a per-model `c` beats `[*]`;
`writePiModels` writes the effective window and `replyTokenBudget` of it; a
session is reset when the window changes; `null` leaves the snapshot without a
total, skips the image pre-flight, and never reaches Pi; the migration strips
exactly `16384` from `[*]` and leaves `8192` alone, and does not run twice; and a
capped model reports the cap from `/props` after loading, which is the only proof
that the cap did anything.

## Phase 5: Display Preferences

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

## Phase 6: Paste Long Text To A File

The composer catches a paste of more than `pasteToFileCharacters` characters
(default 2500, `0` disables) and posts it to `POST /api/uploads` as a `.txt`
instead of dropping 40,000 characters into the input.

The client keeps the paste event, because only it has one. The threshold and the
ingestion are already server-side; this phase is mostly wiring, and it is the
cheapest real improvement in this plan.

**Tests.** e2e: paste 3,000 characters, see a chip and an empty composer; paste
2,000, see them in the composer; set the threshold to `0` and paste 100,000,
see them in the composer.

## Phase 7: Maximum Image Resolution

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
3. **Phase 3 (model param validation)** — before anyone is encouraged to type
   `temp` into the params editor and take llama.cpp down with a typo. Covers the
   global `[*]` params and the per-model params, and marks the offending rows
   rather than printing one sentence above a form. Its option catalogue is what
   Phase 4 needs to recognise every spelling of `ctx-size`.
4. **Phase 4 (context window)** — the riskiest change here, and the one that
   makes the other numbers true. It removes a default that has been quietly
   correct-by-construction, so it wants the validation of Phase 3 underneath it
   and a careful eye on the `null` paths.
5. **Phase 6 (paste to file)** — cheapest user-visible win.
6. **Phase 2 (custom instructions)** — the one people ask for.
7. **Phase 5 (display preferences)** — mechanical.
8. **Phase 7 (image cap)** — optional, and honest about being optional.

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
- **Removing the context default changes memory behaviour for every install.**
  gemma-4-26B goes from asking for a 16,384-token KV cache to asking for
  262,144. A machine that was fine yesterday may not load the model today, and
  the fix — cap `c` — has to be discoverable from the failure. Phase 4 is not a
  settings change; it is a resource change wearing a settings change's clothes.
- **`null` is a real value for the context window.** Every arithmetic site must
  say what it does with "unknown" rather than reaching for a constant. The one
  that matters is the image pre-flight: it must skip, not refuse, because
  refusing on an unknown window would reject messages that fit.
