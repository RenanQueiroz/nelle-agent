---
name: model-testing
description: Set up real llama.cpp models for Nelle tests and drives — which small gemma models to import, how to import them, and the runtime.modelsMax requirement for multi-model tests. Use for any model-backed test - an agent-driven UI drive, the slow device tier, or a real end-to-end generation.
---

# Testing with real models

Test against the small models, not the real ones. For any model-backed test
(agent-driven UI drives, the slow device tier, a real generation), use
`unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` (4.22 GB), plus
`unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL` (2.62 GB) whenever a test needs two.
`gemma-4-26B` and `Qwen3.6-35B` are the real workloads; loading one costs tens
of seconds and a lot of RAM, which makes the drive loop useless.

Import with `POST /api/huggingface/use {repoId, quant}` — never hand-roll the
section id (`hf-repo` keeps the exact `…:UD-Q4_K_XL` ref; the section id uses
llama.cpp's canonical `…:Q4_K_XL`).

**Simultaneous multi-model testing needs `runtime.modelsMax >= 2`**: at the
default `1` the router evicts the first model when the second loads, so the test
exercises eviction and reports a pass — worse than a failure, because it looks
green. Before any multi-model run, read `GET /api/runtime` and assert
`modelsMax >= 2` rather than assuming it. It lives in `.nelle/settings.sqlite`,
not in code — the registry keeps the default at `1` on purpose, because a fresh
install on memory-constrained hardware must not try to hold two models. Raise it
per machine with `PATCH /api/settings/runtime`, which needs a llama.cpp restart.
