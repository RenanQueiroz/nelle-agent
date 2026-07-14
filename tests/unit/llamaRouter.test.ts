import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {MODEL_LOAD_TIMEOUT_MS} from '../../packages/shared/src/router.ts';
import {ConversationRepository} from '../../apps/server/src/conversations.ts';
import {AppDatabase} from '../../apps/server/src/database.ts';
import {LlamaCppManager} from '../../apps/server/src/llamacpp.ts';
import {ModelCacheRepository} from '../../apps/server/src/modelCache.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createTestServer} from './helpers/testServer.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import {slowFactor} from './helpers/platform.ts';

process.env.LOG_LEVEL = 'silent';

test('llama router facade normalizes props, models, model props, actions, and events', async () => {
  const router = await createMockRouter();
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createTestServer(paths);

  try {
    const propsResponse = await app.inject({method: 'GET', url: '/api/llama/props'});
    assert.equal(propsResponse.statusCode, 200);
    const props = propsResponse.json<{
      role: string;
      maxInstances: number;
      modelsAutoload: boolean;
    }>();
    assert.equal(props.role, 'router');
    assert.equal(props.maxInstances, 1);
    assert.equal(props.modelsAutoload, false);

    const modelsResponse = await app.inject({method: 'GET', url: '/api/llama/models'});
    assert.equal(modelsResponse.statusCode, 200);
    const models = modelsResponse.json<{
      models: Array<{sectionId: string; alias: string; hfRepo: string; status: string}>;
    }>().models;
    assert.equal(models[0]?.sectionId, 'repo/model:Q4_K_M');
    assert.equal(models[0]?.alias, 'Model Q4');
    assert.equal(models[0]?.hfRepo, 'repo/model:UD-Q4_K_M');
    assert.equal(models[0]?.status, 'loaded');

    const modelPropsResponse = await app.inject({
      method: 'GET',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/props`,
    });
    assert.equal(modelPropsResponse.statusCode, 200);
    const modelProps = modelPropsResponse.json<{
      modelId: string;
      contextWindow: number;
      modalities: {vision: boolean; audio: boolean; video: boolean};
    }>();
    assert.equal(modelProps.modelId, model.id);
    assert.equal(modelProps.contextWindow, 32768);
    assert.deepEqual(modelProps.modalities, {vision: true, audio: false, video: false});

    const tokenizeResponse = await app.inject({
      method: 'POST',
      url: '/api/llama/tokenize',
      payload: {content: 'hello local model'},
    });
    assert.equal(tokenizeResponse.statusCode, 200);
    assert.deepEqual(tokenizeResponse.json<{tokens: number}>(), {
      tokens: 3,
      raw: {tokens: [1, 2, 3]},
    });

    // The load **waits**, and so it is also idempotent: this model is already `loaded`, so there
    // is nothing to do and the router is not asked to do it. `loaded: false` is "it was already
    // runnable", not "it failed" -- a failure throws. (It used to proxy `/models/load` blindly,
    // which answers `{success: true}` the instant the router accepts the *request*, so a Load
    // that died reported success and a Load that succeeded never pinned the weights.)
    const loadResponse = await app.inject({
      method: 'POST',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/load`,
    });
    assert.equal(loadResponse.statusCode, 200);
    const load = loadResponse.json<{modelId: string; loaded: boolean}>();
    assert.equal(load.modelId, model.id);
    assert.equal(load.loaded, false, 'already loaded: nothing to do');

    const unloadResponse = await app.inject({
      method: 'POST',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/unload`,
    });
    assert.equal(unloadResponse.statusCode, 200);
    assert.equal(unloadResponse.json<{modelId: string}>().modelId, model.id);

    const reloadResponse = await app.inject({
      method: 'POST',
      url: '/api/llama/models/reload',
    });
    assert.equal(reloadResponse.statusCode, 200);
    assert.ok(router.calls.some(call => call.url === '/models?reload=1'));

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/llama/models/events',
    });
    assert.equal(eventsResponse.statusCode, 200);
    assert.match(eventsResponse.body, /event: model_status/);

    // Unload always reaches the router. Load did not, and must not: the model was already
    // loaded, so asking llama.cpp to load it again would be a request with no meaning.
    const actionBodies = router.calls
      .filter(call => call.url === '/models/load' || call.url === '/models/unload')
      .map(call => call.body);
    assert.deepEqual(actionBodies, [{model: model.id}]);
  } finally {
    await app.close();
    await router.close();
  }
});

test('router responses populate the model cache and survive a stopped router', async () => {
  const router = await createMockRouter();
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createTestServer(paths);
  const database = new AppDatabase(paths);
  await database.open();

  try {
    const cache = new ModelCacheRepository(database);
    assert.equal(cache.getModel(model.id), null, 'nothing is cached before the router answers');

    await app.inject({method: 'GET', url: '/api/llama/models'});
    const afterModels = cache.getModel(model.id);
    assert.equal(afterModels?.status, 'loaded');
    assert.equal(afterModels?.hfRepo, 'repo/model:UD-Q4_K_M');
    assert.equal(afterModels?.alias, 'Model Q4');
    // /models says nothing about modalities, so vision is unknown, not absent.
    assert.equal(cache.getVisionSupport(model.id), null);

    await app.inject({
      method: 'GET',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/props`,
    });
    const afterProps = cache.getModel(model.id);
    assert.equal(afterProps?.modalities?.vision, true);
    assert.equal(afterProps?.contextWindow, 32768);
    assert.equal(cache.getVisionSupport(model.id), true);
    // The props call must not clobber what /models reported.
    assert.equal(afterProps?.status, 'loaded');

    // Stopping llama.cpp does not erase what Nelle last knew about the model.
    await router.close();
    await app.inject({method: 'GET', url: '/api/llama/models'});
    assert.equal(cache.getVisionSupport(model.id), true);

    // Removing the section from models.ini does.
    await app.inject({method: 'DELETE', url: `/api/models/${encodeURIComponent(model.id)}`});
    assert.equal(cache.getModel(model.id), null);
  } finally {
    database.close();
    await app.close();
    await router.close();
  }
});

test('the facade keys every configured model by its section id', async () => {
  // The router reports this model under its runtime id, never under the
  // models.ini section id. The client used to re-derive the join five ways; the
  // server owes it a row keyed by section id so it does not have to.
  const router = await createMockRouter({
    models: [
      {
        id: 'repo/model:UD-Q4_K_M',
        aliases: ['some-alias'],
        source: 'repo/model:UD-Q4_K_M',
        status: {value: 'loaded'},
      },
    ],
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createTestServer(paths);

  try {
    const models = (await app.inject({method: 'GET', url: '/api/llama/models'})).json<{
      models: Array<{sectionId: string; routerModelId?: string; status: string}>;
    }>().models;

    const row = models.find(item => item.sectionId === model.id);
    assert.ok(row, 'the configured model must appear keyed by its section id');
    assert.equal(row.status, 'loaded', 'and carry the live status the router reported');
    assert.equal(row.routerModelId, 'repo/model:UD-Q4_K_M');
  } finally {
    await app.close();
    await router.close();
  }
});

test('models.ini is the catalog: the router may not add to it', async () => {
  // llama.cpp's `server_models::load_models()` calls `load_from_cache()` unconditionally --
  // there is no flag to turn it off -- so the router advertises every GGUF sitting in the
  // download cache as loadable, plus a synthetic `default`. Observed live against a
  // four-section models.ini: six models, including a `gemma-4-12B` nobody had configured
  // (`source: "cache"`, `can_remove: true`) and llama.cpp's `default`.
  //
  // Those are not Nelle's models: they have no params, no `/api/models` row, no Pi entry,
  // and nothing can manage them. `models.ini` is the catalog.
  const router = await createMockRouter({
    models: [
      {id: 'default', aliases: [], status: {value: 'unloaded'}},
      {
        id: 'someone/else-GGUF:Q8_0',
        aliases: [],
        source: 'cache',
        can_remove: true,
        status: {value: 'unloaded'},
      },
      {
        id: 'repo/model:UD-Q4_K_M',
        aliases: [],
        source: 'repo/model:UD-Q4_K_M',
        status: {value: 'loaded'},
      },
    ],
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createTestServer(paths);

  try {
    const models = (await app.inject({method: 'GET', url: '/api/llama/models'})).json<{
      models: Array<{sectionId: string; status: string}>;
    }>().models;

    assert.deepEqual(
      models.map(item => item.sectionId),
      [model.id],
      'only the configured model -- not the cached stranger, and not llama.cpp default',
    );
    // ...and it still carries the live status the router reported for it, so filtering
    // costs nothing.
    assert.equal(models[0]?.status, 'loaded');
  } finally {
    await app.close();
    await router.close();
  }
});

test('the Settings load caches props too, not just a chat run', async () => {
  // Two paths load a model, and for a while only the *run* cached what llama.cpp then knew about
  // it. So a model loaded from Settings sat there `loaded` with no architecture, no context
  // window, and `canReason`/`canAttachImages` of "unknown" -- for ever, because the `/props` route
  // is the only other writer and it fires only because a client asked. Driven: a freshly imported
  // model, loaded from its own detail screen, whose own screen then said its architecture was
  // unknown.
  const statuses = ['unloaded', 'loaded'];
  let statusIndex = 0;
  const router = await createMockRouter({
    modelsFactory: () => {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)]!;
      statusIndex += 1;
      return [{id: 'repo/model:Q4_K_M', aliases: [], status: {value: status}}];
    },
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createTestServer(paths);

  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/load`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<{loaded: boolean}>().loaded, true);

    // The load asked llama.cpp what the model is, without any client doing so.
    assert.ok(
      router.calls.some(call => call.url.startsWith('/props')),
      'a successful load must fetch the props it is now able to fetch',
    );
  } finally {
    await app.close();
    await router.close();
  }
});

test('a run loads the model and caches its props with no client asking', async () => {
  // The props route is the only writer of model_cache's modality columns today,
  // and it fires because a client asked. A thin client never asks.
  const statuses = ['unloaded', 'loading', 'loaded'];
  let statusIndex = 0;
  const router = await createMockRouter({
    modelsFactory: () => {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)]!;
      statusIndex += 1;
      return [
        {
          id: 'repo/model:Q4_K_M',
          aliases: [],
          status: {value: status},
          progress: status === 'loading' ? 0.5 : undefined,
        },
      ];
    },
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const database = new AppDatabase(paths);
  await database.open();

  try {
    const llama = new LlamaCppManager(paths, store);
    const cache = new ModelCacheRepository(database);
    assert.equal(cache.getVisionSupport(model.id), null, 'nothing is known before the load');

    const progress: Array<{status: string; progress?: number}> = [];
    const result = await llama.ensureModelRunnable(model.id, {
      onProgress: update => progress.push(update),
      pollMs: 1,
    });

    assert.equal(result.loaded, true);
    assert.ok(
      router.calls.some(call => call.url === '/models/load'),
      'an unloaded model is loaded exactly once',
    );
    assert.equal(router.calls.filter(call => call.url === '/models/load').length, 1);
    assert.deepEqual(
      progress.map(update => update.status),
      ['loading', 'loaded'],
      'and the wait reports what it is waiting for',
    );

    // The step that keeps every derived capability alive for a thin client.
    cache.upsertModelProps(model.id, await llama.getModelProps(model.id));
    assert.equal(cache.getVisionSupport(model.id), true);
    assert.equal(cache.getModel(model.id)?.contextWindow, 32_768);
  } finally {
    database.close();
    await router.close();
  }
});

test('a run does not load a model the router already has', async () => {
  const router = await createMockRouter();
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);

  try {
    // The default mock reports the model `loaded`; `sleeping` counts too, because
    // llama.cpp keeps the weights and wakes it on the next request.
    const result = await new LlamaCppManager(paths, store).ensureModelRunnable(model.id, {
      pollMs: 1,
    });
    assert.equal(result.loaded, false);
    assert.equal(
      router.calls.some(call => call.url === '/models/load'),
      false,
    );
  } finally {
    await router.close();
  }
});

test('a model that fails to load ends the run with model_load_failed', async () => {
  const router = await createMockRouter({
    modelsFactory: () => [{id: 'repo/model:Q4_K_M', aliases: [], status: {value: 'failed'}}],
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);

  try {
    await assert.rejects(
      () => new LlamaCppManager(paths, store).ensureModelRunnable(model.id, {pollMs: 1}),
      (error: Error & {code?: string}) => error.code === 'model_load_failed',
    );
  } finally {
    await router.close();
  }
});

test('a child that dies at startup fails the run, rather than grinding to the timeout', async () => {
  // **The router never marks it `failed`.** `POST /models/load` answers `{success: true}` -- it
  // accepted the *request* -- and if the child then exits before loading a byte (a bad `ctk`
  // value, a preset it will not parse), llama.cpp leaves the model at `unloaded` and records the
  // exit code, and nothing else ever happens. Measured against the real router: 7 seconds of
  // polling, `unloaded` and `exit_code: 1` on every single tick, no `loading`, no `failed`.
  //
  // Without this, the poll loop runs its full 30s deadline and reports "did not finish loading"
  // -- a bare `model_load_failed` after half a minute, when llama.cpp knew the reason instantly
  // and had already written it in the log.
  const router = await createMockRouter({
    modelsFactory: () => [
      {id: 'repo/model:Q4_K_M', aliases: [], status: {value: 'unloaded', exit_code: 1}},
    ],
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);

  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => new LlamaCppManager(paths, store).ensureModelRunnable(model.id, {pollMs: 1}),
      (error: Error & {code?: string; logRef?: string}) =>
        error.code === 'model_load_failed' &&
        // The exit code is the evidence, so it must be in the sentence...
        /exited with code 1/.test(error.message) &&
        // ...and the reason itself is llama.cpp's, in the log. Nelle never guesses at it.
        typeof error.logRef === 'string',
    );
    // It must fail on the *evidence*, not by outlasting the deadline.
    assert.ok(
      Date.now() - startedAt < MODEL_LOAD_TIMEOUT_MS,
      'the run must not wait out the full load timeout to report a failure it can already see',
    );
  } finally {
    await router.close();
  }
});

test('a load that is merely slow is not mistaken for a dead child', async () => {
  // The exit code cannot say which attempt it belongs to: a *previous* failure leaves the same
  // `1` sitting there while the next load is starting up. So the model gets a grace window to
  // reach `loading` -- and once it has, a stale exit code must never be read as this load's.
  const router = await createMockRouter({
    modelsFactory: () => [
      {id: 'repo/model:Q4_K_M', aliases: [], status: {value: 'loading', exit_code: 1}},
    ],
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);

  try {
    await assert.rejects(
      () =>
        new LlamaCppManager(paths, store).ensureModelRunnable(model.id, {
          pollMs: 1 * slowFactor,
          timeoutMs: 200 * slowFactor,
        }),
      // It times out -- which is right, because it never stopped loading. It must NOT be
      // reported as an exited child.
      (error: Error) => /did not finish loading/.test(error.message),
    );
  } finally {
    await router.close();
  }
});

test('a load that never finishes times out rather than hanging the run', async () => {
  const router = await createMockRouter({
    modelsFactory: () => [{id: 'repo/model:Q4_K_M', aliases: [], status: {value: 'loading'}}],
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);

  try {
    await assert.rejects(
      () =>
        new LlamaCppManager(paths, store).ensureModelRunnable(model.id, {
          pollMs: 1 * slowFactor,
          timeoutMs: 5 * slowFactor,
        }),
      /did not finish loading/,
    );
  } finally {
    await router.close();
  }
});

test('the server decides whether a model can reason, and caches the answer', async () => {
  // Whether a model can think is a property of its chat template. llama.cpp ships
  // the template; the client used to carry llama.cpp's detector to read it.
  const thinking = await createMockRouter({
    chatTemplate: '{%- if enable_thinking is defined and enable_thinking -%}',
  });
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: thinking.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createTestServer(paths);
  const database = new AppDatabase(paths);
  await database.open();

  try {
    const cache = new ModelCacheRepository(database);
    assert.equal(cache.getReasoningSupport(model.id), null, 'unknown until llama.cpp answers');

    const props = (
      await app.inject({
        method: 'GET',
        url: `/api/llama/models/${encodeURIComponent(model.id)}/props`,
      })
    ).json<{canReason: boolean | null; chatTemplate: string}>();
    assert.equal(props.canReason, true);

    // Cached, so a client that never fetches props still learns it.
    assert.equal(cache.getReasoningSupport(model.id), true);

    const conversation = new ConversationRepository(database).createConversation({
      title: 'Reasoning capability',
      defaultModelId: model.id,
    });
    const snapshot = (
      await app.inject({method: 'GET', url: `/api/conversations/${conversation.id}`})
    ).json<{snapshot: {capabilities: {canReason: boolean | null}}}>().snapshot;
    assert.equal(snapshot.capabilities.canReason, true);
  } finally {
    database.close();
    await app.close();
    await thinking.close();
  }
});

test('a template with no thinking mode reports canReason false, not null', async () => {
  const router = await createMockRouter({chatTemplate: 'chatml'});
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);

  try {
    const props = await new LlamaCppManager(paths, store).getModelProps(model.id);
    // `false` locks the reasoning control; `null` would leave it editable. They
    // are not the same answer.
    assert.equal(props.canReason, false);
  } finally {
    await router.close();
  }
});

test('llama abort verifier warns when slots keep processing after grace window', async () => {
  const processingSlot = {
    id: 2,
    id_task: 91,
    is_processing: true,
    next_token: [{has_next_token: true, n_decoded: 128}],
  };
  const router = await createMockRouter({slots: [[processingSlot], []]});
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const llama = new LlamaCppManager(paths, store);

  try {
    const stuck = await llama.verifyAbortIdle({
      modelId: 'repo/model:Q4_K_M',
      graceMs: 0,
      pollMs: 50,
    });
    assert.equal(stuck.checked, true);
    assert.equal(stuck.idle, false);
    assert.equal(stuck.warning?.code, 'llama_slot_still_processing');
    assert.match(stuck.warning?.detail ?? '', /slot 2 task 91/);

    const idle = await llama.verifyAbortIdle({
      modelId: 'repo/model:Q4_K_M',
      graceMs: 0,
      pollMs: 50,
    });
    assert.equal(idle.checked, true);
    assert.equal(idle.idle, true);
    assert.equal(idle.warning, undefined);
  } finally {
    await router.close();
  }
});

test('llama router facade returns stable 502 errors for upstream failures', async () => {
  const router = await createMockRouter({failModels: true});
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const app = await createTestServer(paths);

  try {
    const response = await app.inject({method: 'GET', url: '/api/llama/models'});
    assert.equal(response.statusCode, 502);
    assert.equal(
      response.json<{error: {code: string}}>().error.code,
      'llama_router_request_failed',
    );
  } finally {
    await app.close();
    await router.close();
  }
});

test('model settings endpoints edit params, duplicate, and remove sections', async () => {
  const router = await createMockRouter();
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset();
  const app = await createTestServer(paths);

  try {
    const globalResponse = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {c: '16384', threads: '6'}},
    });
    assert.equal(globalResponse.statusCode, 200);
    assert.deepEqual(
      globalResponse.json<{globalModelParams: Record<string, string>}>().globalModelParams,
      {
        c: '16384',
        threads: '6',
      },
    );

    const invalidResponse = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {params: {'hf-repo': 'other/model:Q4_K_M'}},
    });
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(
      invalidResponse.json<{error: {code: string}}>().error.code,
      'reserved_model_param',
    );

    const editResponse = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {name: 'Edited alias', params: {'ctx-size': '32768'}},
    });
    assert.equal(editResponse.statusCode, 200);
    assert.equal(editResponse.json<{model: {name: string}}>().model.name, 'Edited alias');

    const duplicateResponse = await app.inject({
      method: 'POST',
      url: `/api/models/${encodeURIComponent(model.id)}/duplicate`,
    });
    assert.equal(duplicateResponse.statusCode, 200);
    const duplicateId = duplicateResponse.json<{model: {id: string}}>().model.id;
    assert.match(duplicateId, /copy/);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(model.id)}`,
    });
    assert.equal(deleteResponse.statusCode, 200);

    const preset = await fs.readFile(paths.llamaPresetPath, 'utf8');
    assert.match(preset, /\[\*\]/);
    assert.match(preset, /c = 16384/);
    assert.doesNotMatch(preset, /\[repo\/model:Q4_K_M\]/);
    assert.match(preset, new RegExp(`\\[${escapeRegExp(duplicateId)}\\]`));
    assert.ok(router.calls.some(call => call.url === '/models?reload=1'));
  } finally {
    await app.close();
    await router.close();
  }
});

async function createMockRouter(
  input: {
    failModels?: boolean;
    slots?: unknown[][];
    models?: unknown[];
    /** Called per `/models` request, so a status can change between polls. */
    modelsFactory?: () => unknown[];
    chatTemplate?: string;
  } = {},
): Promise<{
  port: number;
  calls: Array<{method: string; url: string; body: unknown}>;
  close: () => Promise<void>;
}> {
  const calls: Array<{method: string; url: string; body: unknown}> = [];
  let slotCallCount = 0;
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? '/';
    const body = await readJsonBody(request);
    calls.push({method: request.method ?? 'GET', url, body});

    if (url === '/v1/models') {
      sendJson(response, {data: []});
      return;
    }
    if (url === '/props') {
      sendJson(response, {role: 'router', max_instances: 1, models_autoload: false});
      return;
    }
    if (url.startsWith('/props?')) {
      sendJson(response, {
        modalities: {vision: true, audio: false, video: false},
        default_generation_settings: {n_ctx: 32768},
        chat_template: input.chatTemplate ?? 'chatml',
      });
      return;
    }
    if (url === '/tokenize') {
      sendJson(response, {tokens: [1, 2, 3]});
      return;
    }
    if (url.startsWith('/slots')) {
      const slots =
        input.slots?.[Math.min(slotCallCount, Math.max(0, input.slots.length - 1))] ?? [];
      slotCallCount += 1;
      sendJson(response, slots);
      return;
    }
    if (url === '/models/sse') {
      response.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'});
      response.end('event: model_status\ndata: {"id":"repo/model:Q4_K_M"}\n\n');
      return;
    }
    if (url === '/models/load' || url === '/models/unload') {
      sendJson(response, {ok: true});
      return;
    }
    if (url === '/models' || url === '/models?reload=1') {
      if (input.failModels) {
        response.writeHead(500, {'content-type': 'text/plain'});
        response.end('router failed');
        return;
      }
      if (input.modelsFactory) {
        sendJson(response, input.modelsFactory());
        return;
      }
      if (input.models) {
        sendJson(response, input.models);
        return;
      }
      sendJson(response, [
        {
          id: 'repo/model:Q4_K_M',
          aliases: ['repo/model:Q4_K_M'],
          source: 'repo/model:UD-Q4_K_M',
          status: {value: 'loaded'},
          can_remove: false,
          architecture: 'qwen3',
        },
      ]);
      return;
    }

    response.writeHead(404, {'content-type': 'text/plain'});
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  // `server.address()` is `string | AddressInfo | null` -- a string for a unix socket. This helper
  // only ever listens on TCP, so assert that rather than reaching for `.port` on the union.
  assert.ok(address && typeof address === 'object', 'expected a TCP address, not a unix socket');

  return {
    port: address.port,
    calls,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += String(chunk);
  }
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

function sendJson(response: http.ServerResponse, payload: unknown): void {
  response.writeHead(200, {'content-type': 'application/json'});
  response.end(JSON.stringify(payload));
}

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-'));
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    modelsDir: path.join(dataDir, 'models'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    uploadsDir: path.join(dataDir, 'uploads'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaPidPath: path.join(llamaDir, 'llama-server.pid.json'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piSessionsDir: path.join(piDir, 'sessions'),
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    settingsDbPath: path.join(dataDir, 'settings.sqlite'),
    statePath: path.join(dataDir, 'state.json'),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
