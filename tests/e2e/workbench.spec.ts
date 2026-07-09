import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test, type Page} from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

test('loads the Nelle workbench and searches GGUF models', async ({page}) => {
  await page.route('**/api/huggingface/search**', async route => {
    await route.fulfill({
      json: {
        results: [
          {
            id: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
            author: 'unsloth',
            downloads: 42_000,
            likes: 700,
            tags: ['gguf', 'conversational'],
            files: [
              {
                filename: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
                size: 22_000_000_000,
              },
              {
                filename: 'Qwen3.6-35B-A3B-UD-Q5_K_M.gguf',
                size: 27_000_000_000,
              },
            ],
            quants: [
              {
                quant: 'UD-Q4_K_XL',
                size: 22_000_000_000,
                files: [
                  {
                    filename: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
                    size: 22_000_000_000,
                  },
                ],
              },
              {
                quant: 'UD-Q5_K_M',
                size: 27_000_000_000,
                files: [
                  {
                    filename: 'Qwen3.6-35B-A3B-UD-Q5_K_M.gguf',
                    size: 27_000_000_000,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');

  await expect(page.getByRole('heading', {name: 'Nelle Agent'})).toBeVisible();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
  await expect(page.getByRole('button', {name: 'New chat'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Send'})).toHaveCount(1);

  await page.getByRole('button', {name: 'Settings'}).click();
  await expect(page.getByRole('heading', {name: 'llama.cpp'})).toBeVisible();
  await expect(page.getByText('Not installed')).toBeVisible();
  await expect(page.getByLabel('Max loaded models')).toHaveValue('1');
  await expect(page.getByLabel('Sleep idle seconds')).toHaveValue('90');

  await page.getByRole('button', {name: 'Show logs'}).click();
  await expect(page.getByText('No llama-server log output yet.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Hide logs'})).toBeVisible();

  await page.getByRole('button', {name: 'Models'}).click();
  await page.getByLabel('Search query').fill('qwen gguf');
  await page.getByRole('button', {name: 'Search GGUF models'}).click();

  await expect(page.getByText('unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBeVisible();
  await expect(page.getByText('UD-Q4_K_XL')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Use'}).first()).toBeVisible();

  await page.getByRole('button', {name: 'Use'}).first().click();

  await expect(page.getByText('unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL').first()).toBeVisible();
  await expect(page.getByRole('button', {name: 'Selected'})).toBeVisible();
  await expect(page.getByText('router stopped').last()).toBeVisible();
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]');
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL');

  await page.getByRole('button', {name: 'Global Params'}).click();
  await page.getByLabel('Value').first().fill('12288');
  await page.getByRole('button', {name: 'Save global params'}).click();
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('c = 12288');

  await page.getByRole('button', {name: 'Models'}).click();
  await page.getByLabel('Alias').fill('Qwen alias');
  await page.getByLabel('Key').fill('ctx-size');
  await page.getByLabel('Value').fill('32768');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('alias = Qwen alias');
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('ctx-size = 32768');
});

test('shows router model status and load/unload controls', async ({page}) => {
  const model = {
    id: 'repo/model:Q4_K_M',
    name: 'Model Q4',
    presetName: 'repo/model:Q4_K_M',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };
  let status = 'loaded';
  let loadCalls = 0;
  let unloadCalls = 0;
  let reloadCalls = 0;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat: []});
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status,
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await page.route('**/api/llama/props', async route => {
    await route.fulfill({
      json: {
        role: 'router',
        maxInstances: 1,
        modelsAutoload: false,
        runtime,
        raw: {role: 'router', max_instances: 1, models_autoload: false},
      },
    });
  });
  await page.route('**/api/llama/models/reload', async route => {
    reloadCalls += 1;
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status,
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await page.route(/\/api\/llama\/models\/.+\/unload$/, async route => {
    unloadCalls += 1;
    status = 'unloaded';
    await route.fulfill({json: {ok: true}});
  });
  await page.route(/\/api\/llama\/models\/.+\/load$/, async route => {
    loadCalls += 1;
    status = 'loaded';
    await route.fulfill({json: {ok: true}});
  });

  await page.goto('/');

  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'Models'}).click();
  await expect(page.getByText('loaded', {exact: true}).last()).toBeVisible();
  await expect(page.getByText(`router id: ${model.id}`)).toBeVisible();
  await page.getByRole('button', {name: 'Runtime'}).click();
  await expect(page.getByText('Router capacity: 1/1 loaded')).toBeVisible();
  await page.getByRole('button', {name: 'Models'}).click();
  await expect(page.getByRole('button', {name: 'Load', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Unload', exact: true}).click();
  await expect(page.getByText('unloaded', {exact: true}).last()).toBeVisible();
  await expect.poll(() => unloadCalls).toBe(1);

  await page.getByRole('button', {name: 'Load', exact: true}).click();
  await expect.poll(() => loadCalls).toBe(1);
  await expect(page.getByText('loaded', {exact: true}).last()).toBeVisible();

  await page.getByRole('button', {name: 'Reload'}).click();
  await expect.poll(() => reloadCalls).toBe(1);
});

test('loads an unloaded router model from the composer selector', async ({page}) => {
  const modelA = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const modelB = {
    id: 'model-b',
    name: 'Model B',
    presetName: 'model-b',
    source: 'huggingface',
    repoId: 'repo/model-b',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-b:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: modelA.id,
    lastError: null,
  };
  let activeModelId = modelA.id;
  let modelBStatus = 'unloaded';
  let activateCalls = 0;
  let loadCalls = 0;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId,
          models: [modelA, modelB],
          chat: [],
        },
        runtime: {...runtime, activeModelId},
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: {...runtime, activeModelId}});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: modelA.id,
            routerModelId: modelA.id,
            alias: modelA.name,
            hfRepo: modelA.hfRef,
            status: 'loaded',
            aliases: [modelA.id],
          },
          {
            sectionId: modelB.id,
            routerModelId: modelB.id,
            alias: modelB.name,
            hfRepo: modelB.hfRef,
            status: modelBStatus,
            aliases: [modelB.id],
          },
        ],
      },
    });
  });
  await page.route('**/api/llama/models/**/props', async route => {
    await route.fulfill({
      json: {
        modelId: activeModelId,
        modalities: {vision: false, audio: false, video: false},
        contextWindow: 8192,
        raw: {},
      },
    });
  });
  await page.route('**/api/models/model-b/activate', async route => {
    activateCalls += 1;
    activeModelId = modelB.id;
    await route.fulfill({json: {model: modelB}});
  });
  await page.route(/\/api\/llama\/models\/model-b\/load$/, async route => {
    loadCalls += 1;
    modelBStatus = 'loaded';
    await route.fulfill({json: {ok: true}});
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');

  const composerModelButton = page.getByRole('button', {name: 'Model', exact: true});
  await expect(composerModelButton).toContainText('Model A');
  await expect(page.getByText('loaded', {exact: true}).last()).toBeVisible();

  await page.getByRole('button', {name: 'Favorite model'}).click();
  await expect(page.getByRole('button', {name: 'Unfavorite model'})).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('nelle.favoriteModelIds')))
    .toContain(modelA.id);

  await composerModelButton.click();
  await expect(page.getByText('Favorites')).toBeVisible();
  await page.getByPlaceholder('Search models').fill('Model B');
  await page.getByRole('option', {name: /Model B/}).click();

  await expect.poll(() => loadCalls).toBe(1);
  await expect.poll(() => activateCalls).toBe(1);
  await expect(composerModelButton).toContainText('Model B');
  await expect(page.getByText('loaded', {exact: true}).last()).toBeVisible();
});

test('loads an unloaded selected model before sending chat', async ({page}) => {
  const model = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };
  const chat: MockChatMessage[] = [];
  let modelStatus = 'unloaded';
  let loadCalls = 0;
  let streamCalls = 0;
  let streamSawLoadedModel = false;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: modelStatus,
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await page.route(/\/api\/llama\/models\/model-a\/load$/, async route => {
    loadCalls += 1;
    modelStatus = 'loaded';
    await route.fulfill({json: {ok: true}});
  });
  await mockConversationRoutes(page, {chat});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    streamCalls += 1;
    streamSawLoadedModel = modelStatus === 'loaded';
    const userMessage = {
      id: 'user-1',
      role: 'user',
      content: 'hello after eviction',
      createdAt: '2026-07-07T12:01:00.000Z',
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Loaded before chat.',
      createdAt: '2026-07-07T12:01:01.000Z',
      modelId: model.id,
      modelRuntimeId: model.id,
      modelAliasSnapshot: model.name,
    };
    chat.push(userMessage, assistantMessage);
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {type: 'user_message', message: userMessage},
        {
          type: 'assistant_start',
          harness: 'pi',
          message: {...assistantMessage, content: ''},
        },
        {type: 'assistant_delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'done', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  const composerModelButton = page.getByRole('button', {name: 'Model', exact: true});
  await expect(composerModelButton).toContainText('Model A');
  await expect(page.getByText('unloaded', {exact: true}).last()).toBeVisible();

  await page.getByLabel('Message input').fill('hello after eviction');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => loadCalls).toBe(1);
  await expect.poll(() => streamCalls).toBe(1);
  expect(streamSawLoadedModel).toBe(true);
  await expect(page.getByText('Loaded before chat.')).toBeVisible();
});

test('requires acknowledgement before enabling host tools', async ({page}) => {
  let hostTools = {
    enabled: false,
    acknowledged: false,
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: null,
          models: [],
          globalModelParams: {c: '8192'},
          runtime: {host: '127.0.0.1', port: 8080, modelsMax: 1, sleepIdleSeconds: 90},
          chat: [],
        },
        runtime: {
          platform: 'linux',
          arch: 'x64',
          dataDir: '.nelle-e2e',
          binaryPath: null,
          logPath: '.nelle-e2e/logs/llama-server.log',
          installMode: 'source-master',
          installed: false,
          installedVersion: null,
          latestVersion: null,
          updateAvailable: false,
          running: false,
          pid: null,
          host: '127.0.0.1',
          port: 8080,
          modelsMax: 1,
          sleepIdleSeconds: 90,
          activeModelId: null,
          lastError: null,
        },
        hostTools,
      },
    });
  });
  await page.route('**/api/settings/host-tools', async route => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as {enabled?: boolean; acknowledged?: boolean};
      if (body.enabled === true && body.acknowledged !== true && !hostTools.acknowledged) {
        await route.fulfill({
          status: 400,
          json: {
            error: {
              code: 'host_tools_acknowledgement_required',
              message: 'Host tools must be acknowledged before they can be enabled.',
            },
          },
        });
        return;
      }
      hostTools = {
        enabled: body.enabled ?? hostTools.enabled,
        acknowledged: body.acknowledged ?? hostTools.acknowledged,
        updatedAt: '2026-07-08T12:00:00.000Z',
      };
    }
    await route.fulfill({json: {hostTools}});
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'Tools'}).click();

  await expect(page.getByRole('heading', {name: 'Host Tools'})).toBeVisible();
  await expect(
    page.getByText('Host file and shell tools run with the same OS permissions'),
  ).toBeVisible();
  await expect(page.getByLabel('Enable host file and shell tools')).toBeDisabled();

  await page.getByRole('button', {name: 'Acknowledge and enable'}).click();
  await expect(page.getByText('enabled', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Enable host file and shell tools')).toBeChecked();
});

test('updates router model selector state from SSE events', async ({page}) => {
  const model = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'unloaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await page.route('**/api/llama/models/events', async route => {
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: `event: download_progress\ndata: ${JSON.stringify({
        id: model.id,
        progress: 35,
      })}\n\n`,
    });
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');

  await expect(page.getByText('loading', {exact: true}).last()).toBeVisible();
  await page.getByRole('button', {name: 'Model', exact: true}).click();
  await expect(page.getByText('35%')).toBeVisible();
});

test('locks model settings while a matching run is active', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'loaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await mockConversationRoutes(page, {chat: []});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: `data: ${JSON.stringify({
        type: 'run.started',
        runId: 'run-model-lock',
        conversationId: 'poc-default',
        kind: 'chat',
        modelId: model.id,
        status: 'running',
        createdAt: '2026-07-07T12:01:00.000Z',
      })}\n\n`,
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('hold this model');
  await page.getByLabel('Message input').press('Enter');

  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'Models'}).click();
  await expect(page.getByText('active run')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Unload'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'Remove model'})).toBeDisabled();
});

test('clears model locks when a run is aborted', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'loaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await mockConversationRoutes(page, {chat: []});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {
          type: 'run.started',
          runId: 'run-model-lock',
          conversationId: 'poc-default',
          kind: 'chat',
          modelId: model.id,
          status: 'running',
          createdAt: '2026-07-07T12:01:00.000Z',
        },
        {
          type: 'run.aborted',
          runId: 'run-model-lock',
          conversationId: 'poc-default',
          reason: 'user',
          createdAt: '2026-07-07T12:01:01.000Z',
        },
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('abort this run');
  await page.getByLabel('Message input').press('Enter');
  await expect(page.getByText('Generation stopped.')).toBeVisible();

  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'Models'}).click();
  await expect(page.getByText('active run')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Unload'})).toBeEnabled();
  await expect(page.getByRole('button', {name: 'Save'})).toBeEnabled();
  await expect(page.getByRole('button', {name: 'Remove model'})).toBeEnabled();
});

test('surfaces llama slot abort warnings from the composer stop action', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };
  const warning =
    'llama.cpp still reports an active generation after stop. Open Settings > Runtime to stop or restart llama.cpp if it does not settle.';
  let releaseStream: () => void = () => {};
  const streamReleased = new Promise<void>(resolve => {
    releaseStream = resolve;
  });
  let abortCalls = 0;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'loaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await mockConversationRoutes(page, {
    chat: [],
    abortWarning: {code: 'llama_slot_still_processing', message: warning},
    onAbort: () => {
      abortCalls += 1;
      releaseStream();
    },
  });
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    await streamReleased;
    await route
      .fulfill({
        headers: {'content-type': 'text/event-stream; charset=utf-8'},
        body: '',
      })
      .catch(() => undefined);
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('stop this run');
  await page.getByLabel('Message input').press('Enter');
  // The composer stays interactive during a run, so stop takes a real click.
  const stopButton = page.getByRole('button', {name: 'Stop'});
  await expect(stopButton).toBeEnabled();
  await stopButton.click();

  await expect.poll(() => abortCalls).toBe(1);
  await expect(page.getByText(warning).first()).toBeVisible();
});

test('keeps per-conversation run state while another chat is active', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: model.id,
    lastError: null,
  };
  const conversations = [
    {
      id: 'poc-default',
      title: 'Primary chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T12:00:00.000Z',
    },
    {
      id: 'second-chat',
      title: 'Second chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T11:59:00.000Z',
    },
  ] satisfies MockConversation[];
  const streamCalls: string[] = [];

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'loaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await mockConversationRoutes(page, {chat: [], conversations});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    streamCalls.push('poc-default');
    conversations[0]!.status = 'running';
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: `data: ${JSON.stringify({
        type: 'run.started',
        runId: 'run-primary',
        conversationId: 'poc-default',
        kind: 'chat',
        modelId: model.id,
        status: 'running',
        createdAt: '2026-07-07T12:01:00.000Z',
      })}\n\n`,
    });
  });
  await page.route('**/api/conversations/second-chat/chat/stream', async route => {
    streamCalls.push('second-chat');
    conversations[1]!.status = 'running';
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {
          type: 'run.started',
          runId: 'run-second',
          conversationId: 'second-chat',
          kind: 'chat',
          modelId: model.id,
          status: 'running',
          createdAt: '2026-07-07T12:02:00.000Z',
        },
        {
          type: 'run.completed',
          runId: 'run-second',
          conversationId: 'second-chat',
          status: 'completed',
          createdAt: '2026-07-07T12:02:01.000Z',
        },
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('start primary run');
  await page.getByLabel('Message input').press('Enter');
  await expect.poll(() => streamCalls).toContainEqual('poc-default');
  await expect(
    page.getByTestId('conversation-row-poc-default').getByText('running', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('conversation-row-poc-default')
      .getByRole('status', {name: 'Conversation running in progress'}),
  ).toBeVisible();

  await page.getByRole('button', {name: 'Second chat', exact: true}).click();
  await expect(page.getByLabel('Message input')).toBeEnabled();
  await page.getByLabel('Message input').fill('start second run');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toEqual(['poc-default', 'second-chat']);
  await expect(
    page.getByTestId('conversation-row-poc-default').getByText('running', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('conversation-row-poc-default')
      .getByRole('status', {name: 'Conversation running in progress'}),
  ).toBeVisible();
});

test('renders llama.cpp prompt and generation throughput in chat message metadata', async ({
  page,
}) => {
  const model = {
    id: 'model-1',
    name: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    presetName: 'unsloth-qwen',
    source: 'huggingface',
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
    hfRef: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & {copiedText?: string}).copiedText = value;
        },
      },
    });
  });

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models/**/props', async route => {
    await route.fulfill({
      json: {
        modelId: model.id,
        modalities: {vision: false, audio: false, video: false},
        contextWindow: 8192,
        raw: {},
      },
    });
  });
  const chat: Array<{id: string; role: string; content: string; createdAt: string}> = [];
  await mockConversationRoutes(page, {chat});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    const userMessage = {
      id: 'user-1',
      role: 'user',
      content: 'hello',
      createdAt: '2026-07-07T12:01:00.000Z',
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hello from Nelle.',
      createdAt: '2026-07-07T12:01:01.000Z',
      modelId: model.id,
      modelRuntimeId: model.id,
      modelAliasSnapshot: model.name,
      performance: {
        source: 'llamacpp-timings',
        prompt: {
          tokens: 44,
          totalTokens: 128,
          milliseconds: 1362.23,
          tokensPerSecond: 32.3,
        },
        generation: {
          tokens: 6,
          milliseconds: 278.688,
          tokensPerSecond: 21.529452290733722,
        },
      },
    };
    chat.push(userMessage, assistantMessage);
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {type: 'user_message', message: userMessage},
        {
          type: 'assistant_start',
          harness: 'llamacpp',
          message: {...assistantMessage, content: '', performance: undefined},
        },
        {type: 'assistant_delta', id: assistantMessage.id, delta: assistantMessage.content},
        {
          type: 'assistant_metrics',
          id: assistantMessage.id,
          performance: assistantMessage.performance,
        },
        {type: 'done', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('hello');
  await page.getByLabel('Message input').press('Enter');

  await expect(page.getByText('Hello from Nelle.')).toBeVisible();
  await expect(page.getByText(model.name).first()).toBeVisible();
  await page.getByRole('button', {name: 'Copy response'}).click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & {copiedText?: string}).copiedText))
    .toBe('Hello from Nelle.');
  await expect(page.getByText('Response copied.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Reading (prompt processing)'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Generation (token output)'})).toBeVisible();

  // Generation is the default view whenever the message has generation metrics.
  await expect(page.getByText('6 tokens')).toBeVisible();
  await expect(page.getByText('279ms')).toBeVisible();
  await expect(page.getByText('21.53 t/s')).toBeVisible();

  await page.getByText('21.53 t/s').hover();
  await expect(page.getByText('Generation speed')).toBeVisible();

  await page.getByTestId('composer-context-progress').hover();
  await expect(page.getByText('Context: 134 / 8,192 tokens')).toBeVisible();

  await page.getByRole('button', {name: 'Reading (prompt processing)'}).click();
  await expect(page.getByText('44 tokens')).toBeVisible();
  await expect(page.getByText('1.36s')).toBeVisible();
  await expect(page.getByText('32.30 t/s')).toBeVisible();

  await page.getByText('32.30 t/s').hover();
  await expect(page.getByText('Prompt processing speed')).toBeVisible();
});

test('attaches text files and blocks images for text-only models', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };
  const chat: MockChatMessage[] = [];
  let streamCalls = 0;
  let requestBody: {message?: string; attachments?: MockAttachmentRequest[]} | null = null;
  const textFilePath = path.join(repoRoot, '.nelle-e2e', 'attachment-note.txt');
  const imagePath = path.join(repoRoot, '.nelle-e2e', 'attachment-image.png');
  await fs.mkdir(path.dirname(textFilePath), {recursive: true});
  await fs.writeFile(textFilePath, 'Router mode should load models on selection.');
  await fs.writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  );

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models/**/props', async route => {
    await route.fulfill({
      json: {
        modelId: model.id,
        modalities: {vision: false, audio: false, video: false},
        contextWindow: 8192,
        raw: {},
      },
    });
  });
  await mockConversationRoutes(page, {chat});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    streamCalls += 1;
    requestBody = route.request().postDataJSON() as {
      message?: string;
      attachments?: MockAttachmentRequest[];
    };
    const userAttachments = (requestBody.attachments ?? []).map((attachment, index) => ({
      id: `attachment-${index}`,
      conversationId: 'poc-default',
      piEntryId: 'user-1',
      uploadId: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      textPreview: attachment.text?.slice(0, 240),
      createdAt: '2026-07-07T12:01:00.000Z',
    }));
    const userMessage = {
      id: 'user-1',
      role: 'user',
      content: requestBody.message ?? '',
      createdAt: '2026-07-07T12:01:00.000Z',
      attachments: userAttachments,
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I read the attachment.',
      createdAt: '2026-07-07T12:01:01.000Z',
      modelId: model.id,
      modelRuntimeId: model.id,
      modelAliasSnapshot: model.name,
    };
    chat.push(userMessage, assistantMessage);
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {type: 'user_message', message: userMessage},
        {
          type: 'assistant_start',
          harness: 'pi',
          message: {...assistantMessage, content: ''},
        },
        {type: 'assistant_delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'done', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await page.locator('input[aria-label="Attach files"]').setInputFiles(imagePath);
  await expect(page.getByRole('alert')).toContainText('Image attachments require');
  expect(streamCalls).toBe(0);

  await page.locator('input[aria-label="Attach files"]').setInputFiles(textFilePath);
  await expect(page.getByTestId('attachment-drawer')).toContainText('attachment-note.txt');
  await page.getByLabel('Message input').fill('summarize this file');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toBe(1);
  expect(requestBody?.attachments?.[0]?.kind).toBe('text');
  expect(requestBody?.attachments?.[0]?.name).toBe('attachment-note.txt');
  expect(requestBody?.attachments?.[0]?.text).toContain('Router mode should load models');
  await expect(page.getByText('I read the attachment.')).toBeVisible();
  await expect(page.getByText('attachment-note.txt')).toBeVisible();
});

test('renders PDFs as image attachments for vision models', async ({page}) => {
  const model = {
    id: 'vision-model',
    name: 'Vision Model',
    presetName: 'vision-model',
    source: 'huggingface',
    hfRef: 'repo/vision:Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };
  const chat: MockChatMessage[] = [];
  let streamCalls = 0;
  let requestBody: {message?: string; attachments?: MockAttachmentRequest[]} | null = null;
  const pdfPath = path.join(repoRoot, '.nelle-e2e', 'vision-attachment.pdf');
  await fs.mkdir(path.dirname(pdfPath), {recursive: true});
  await fs.writeFile(pdfPath, simplePdfBuffer('Render this PDF as an image'));

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'loaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await page.route('**/api/llama/models/**/props', async route => {
    await route.fulfill({
      json: {
        modelId: model.id,
        modalities: {vision: true, audio: false, video: false},
        contextWindow: 8192,
        raw: {},
      },
    });
  });
  await mockConversationRoutes(page, {chat});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    streamCalls += 1;
    requestBody = route.request().postDataJSON() as {
      message?: string;
      attachments?: MockAttachmentRequest[];
    };
    const userAttachments = (requestBody.attachments ?? []).map((attachment, index) => ({
      id: `attachment-${index}`,
      conversationId: 'poc-default',
      piEntryId: 'user-1',
      uploadId: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      createdAt: '2026-07-07T12:01:00.000Z',
    }));
    const userMessage = {
      id: 'user-1',
      role: 'user',
      content: requestBody.message ?? '',
      createdAt: '2026-07-07T12:01:00.000Z',
      attachments: userAttachments,
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I can see the rendered PDF page.',
      createdAt: '2026-07-07T12:01:01.000Z',
      modelId: model.id,
      modelRuntimeId: model.id,
      modelAliasSnapshot: model.name,
    };
    chat.push(userMessage, assistantMessage);
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {type: 'user_message', message: userMessage},
        {
          type: 'assistant_start',
          harness: 'pi',
          message: {...assistantMessage, content: ''},
        },
        {type: 'assistant_delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'done', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await expect(page.getByLabel('Render PDFs as images')).toBeVisible();
  await page.getByLabel('Render PDFs as images').check();
  await page.locator('input[aria-label="Attach files"]').setInputFiles(pdfPath);

  await expect(page.getByTestId('attachment-drawer')).toContainText('vision-attachment page 1.png');
  await page.getByLabel('Message input').fill('describe this PDF');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toBe(1);
  expect(requestBody?.attachments).toHaveLength(1);
  expect(requestBody?.attachments?.[0]?.kind).toBe('image');
  expect(requestBody?.attachments?.[0]?.name).toBe('vision-attachment page 1.png');
  expect(requestBody?.attachments?.[0]?.mimeType).toBe('image/png');
  expect(requestBody?.attachments?.[0]?.data).toContain('data:image/png;base64,');
  expect(requestBody?.attachments?.[0]?.text).toBeUndefined();
  await expect(page.getByText('I can see the rendered PDF page.')).toBeVisible();
});

test('regenerates an assistant response from the footer model picker', async ({page}) => {
  const modelA = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const modelB = {
    id: 'model-b',
    name: 'Model B',
    presetName: 'model-b',
    source: 'huggingface',
    repoId: 'repo/model-b',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-b:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    logPath: '/tmp/llama.log',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: modelA.id,
    lastError: null,
  };
  const chat: MockChatMessage[] = [
    {
      id: 'user-1',
      role: 'user',
      content: 'Explain router mode',
      createdAt: '2026-07-07T12:00:00.000Z',
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Original answer.',
      createdAt: '2026-07-07T12:01:00.000Z',
      modelId: modelA.id,
      modelRuntimeId: modelA.id,
      modelAliasSnapshot: modelA.name,
    },
  ];
  let modelBStatus = 'unloaded';
  let loadCalls = 0;
  let regenerateCalls = 0;
  let regenerateModelId: string | undefined;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: modelA.id,
          models: [modelA, modelB],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat});
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: modelA.id,
            routerModelId: modelA.id,
            alias: modelA.name,
            hfRepo: modelA.hfRef,
            status: 'loaded',
            aliases: [modelA.id],
          },
          {
            sectionId: modelB.id,
            routerModelId: modelB.id,
            alias: modelB.name,
            hfRepo: modelB.hfRef,
            status: modelBStatus,
            aliases: [modelB.id],
          },
        ],
      },
    });
  });
  await page.route(/\/api\/llama\/models\/model-b\/load$/, async route => {
    loadCalls += 1;
    modelBStatus = 'loaded';
    await route.fulfill({json: {ok: true}});
  });
  await page.route(
    '**/api/conversations/poc-default/messages/assistant-1/regenerate',
    async route => {
      regenerateCalls += 1;
      regenerateModelId = (route.request().postDataJSON() as {modelId?: string}).modelId;
      const regeneratedUser = {
        id: 'user-2',
        role: 'user',
        content: 'Explain router mode',
        createdAt: '2026-07-07T12:02:00.000Z',
      };
      const regeneratedAssistant = {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Regenerated with Model B.',
        createdAt: '2026-07-07T12:02:01.000Z',
        modelId: modelB.id,
        modelRuntimeId: modelB.id,
        modelAliasSnapshot: modelB.name,
        regeneratesPiEntryId: 'assistant-1',
        displayGroupId: 'assistant-1',
      };
      chat.push(regeneratedUser, regeneratedAssistant);
      await route.fulfill({
        headers: {'content-type': 'text/event-stream; charset=utf-8'},
        body: [
          {type: 'user_message', message: regeneratedUser},
          {
            type: 'assistant_start',
            harness: 'pi',
            message: {...regeneratedAssistant, content: ''},
          },
          {
            type: 'assistant_delta',
            id: regeneratedAssistant.id,
            delta: regeneratedAssistant.content,
          },
          {type: 'done', message: regeneratedAssistant},
        ]
          .map(event => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      });
    },
  );

  await page.goto('/');
  await expect(page.getByText('Original answer.')).toBeVisible();
  await page.getByRole('button', {name: /Regenerate model: Model A/}).click();
  await page.getByRole('menuitem', {name: 'Model B'}).click();

  await expect.poll(() => loadCalls).toBe(1);
  await expect.poll(() => regenerateCalls).toBe(1);
  expect(regenerateModelId).toBe(modelB.id);
  await expect(page.getByText('Original answer.')).toBeVisible();
  await expect(page.getByText('Regenerated with Model B.')).toBeVisible();
  await expect(page.getByText('variant 1/2')).toBeVisible();
  await expect(page.getByText('variant 2/2')).toBeVisible();
  await expect(page.getByRole('button', {name: /Regenerate model: Model B/})).toBeVisible();
});

test('duplicates conversations and forks from a user message', async ({page}) => {
  const chat: MockChatMessage[] = [
    {
      id: 'user-1',
      role: 'user',
      content: 'Plan router mode',
      createdAt: '2026-07-07T12:00:00.000Z',
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Use llama.cpp router mode.',
      createdAt: '2026-07-07T12:01:00.000Z',
      modelId: 'model-1',
      modelRuntimeId: 'model-1',
      modelAliasSnapshot: 'Model One',
    },
  ];
  let cloneCalls = 0;
  let forkCalls = 0;
  let forkEntryId: string | undefined;

  await mockConversationRoutes(page, {
    chat,
    conversations: [
      {
        id: 'poc-default',
        title: 'POC chat',
        titleSource: 'fallback',
        pinned: false,
        status: 'ready',
        updatedAt: '2026-07-07T12:00:00.000Z',
      },
    ],
    onClone: () => {
      cloneCalls += 1;
    },
    onFork: (_conversationId, body) => {
      forkCalls += 1;
      forkEntryId = body.entryId;
    },
  });

  await page.goto('/');
  await expect(page.getByText('Use llama.cpp router mode.')).toBeVisible();

  await page.getByRole('button', {name: 'Actions for POC chat'}).click();
  await page.getByRole('menuitem', {name: 'Duplicate'}).click();

  await expect.poll(() => cloneCalls).toBe(1);
  await expect(page.getByRole('button', {name: 'POC chat (copy)', exact: true})).toBeVisible();
  await expect(page.getByText('Conversation duplicated.')).toBeVisible();

  await page.getByRole('button', {name: 'Fork from here'}).click();

  await expect.poll(() => forkCalls).toBe(1);
  expect(forkEntryId).toBe('user-1');
  await expect(
    page.getByRole('button', {name: 'POC chat (copy) (fork)', exact: true}),
  ).toBeVisible();
  await expect(page.getByText('Conversation forked.')).toBeVisible();
  await expect(page.getByText('Plan router mode')).toBeVisible();
  await expect(page.getByText('Use llama.cpp router mode.')).toHaveCount(0);
});

test('exports and imports conversation archives from the sidebar', async ({page}) => {
  const importPath = path.join(repoRoot, '.nelle-e2e', 'imported-chat.nelle-chat.zip');
  await fs.mkdir(path.dirname(importPath), {recursive: true});
  await fs.writeFile(importPath, 'mock archive');
  let exportCalls = 0;
  let importCalls = 0;

  await mockConversationRoutes(page, {
    chat: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Export this',
        createdAt: '2026-07-07T12:00:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'poc-default',
        title: 'Exportable chat',
        titleSource: 'fallback',
        pinned: false,
        status: 'ready',
        updatedAt: '2026-07-07T12:00:00.000Z',
      },
    ],
    importedChat: [
      {
        id: 'import-user',
        role: 'user',
        content: 'Imported prompt',
        createdAt: '2026-07-07T12:05:00.000Z',
      },
      {
        id: 'import-assistant',
        role: 'assistant',
        content: 'Imported answer.',
        createdAt: '2026-07-07T12:06:00.000Z',
      },
    ],
    onExport: () => {
      exportCalls += 1;
    },
    onImport: () => {
      importCalls += 1;
    },
  });

  await page.goto('/');
  await page.getByRole('button', {name: 'Actions for Exportable chat'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();

  await expect.poll(() => exportCalls).toBe(1);
  await expect(page.getByText('Conversation exported.')).toBeVisible();

  await page.locator('input[aria-label="Import conversation archive"]').setInputFiles(importPath);

  await expect.poll(() => importCalls).toBe(1);
  await expect(page.getByRole('button', {name: 'Imported chat', exact: true})).toBeVisible();
  await expect(page.getByText('Imported answer.')).toBeVisible();
  await expect(page.getByText('Conversation imported.')).toBeVisible();
});

test('updates streamed tool calls and shows expandable input and output', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    presetName: 'unsloth-qwen',
    source: 'huggingface',
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
    hfRef: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  const chat: Array<{id: string; role: string; content: string; createdAt: string}> = [];
  await mockConversationRoutes(page, {chat});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    const userMessage = {
      id: 'user-1',
      role: 'user',
      content: 'run a command',
      createdAt: '2026-07-07T12:01:00.000Z',
    };
    const runningCall = {
      id: 'call-1',
      name: 'bash',
      target: 'echo hello',
      status: 'running',
      input: '{\n  "command": "echo hello"\n}',
    };
    const completedCall = {
      ...runningCall,
      status: 'complete',
      duration: '120ms',
      output: 'hello\n',
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done.',
      createdAt: '2026-07-07T12:01:01.000Z',
      modelId: model.id,
      modelRuntimeId: model.id,
      modelAliasSnapshot: model.name,
      toolCalls: [completedCall],
    };
    chat.push(userMessage, assistantMessage);
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {type: 'user_message', message: userMessage},
        {
          type: 'assistant_start',
          harness: 'pi',
          message: {...assistantMessage, content: '', toolCalls: []},
        },
        {type: 'tool', call: runningCall},
        {type: 'tool', call: completedCall},
        {type: 'assistant_delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'done', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('run a command');
  await page.getByLabel('Message input').press('Enter');

  await expect(page.getByText('Done.')).toBeVisible();
  await expect(page.getByText('bash')).toHaveCount(1);
  await page.getByRole('button', {name: /bash/}).click();
  await expect(page.getByText('Input')).toBeVisible();
  await expect(page.getByText('"command": "echo hello"')).toBeVisible();
  await expect(page.getByText('Output')).toBeVisible();
  await expect(page.getByText('hello', {exact: true})).toBeVisible();
});

test('routes compact slash command outside normal chat streaming', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    presetName: 'unsloth-qwen',
    source: 'huggingface',
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
    hfRef: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };
  let compactCalls = 0;
  let streamCalls = 0;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {
    chat: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Please summarize this project',
        createdAt: '2026-07-07T12:00:00.000Z',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Project summary.',
        createdAt: '2026-07-07T12:01:00.000Z',
      },
    ],
    onCompact: () => {
      compactCalls += 1;
    },
  });
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    streamCalls += 1;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: '',
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('/');
  await expect(
    page.getByRole('option', {name: /compact Compact this conversation context/}),
  ).toBeVisible();
  await page.getByLabel('Message input').fill('/compact keep file names');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => compactCalls).toBe(1);
  expect(streamCalls).toBe(0);
  await expect(page.getByText('completed')).toBeVisible();
  await expect(page.getByText('Conversation compacted.')).toBeVisible();
  await page.getByTestId('composer-context-progress').hover();
  await expect(page.getByText('Context: 73 / 8,192 tokens')).toBeVisible();
});

test('rejects unsupported slash commands before they reach chat streaming', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };
  let streamCalls = 0;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat: []});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    streamCalls += 1;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: '',
    });
  });

  await page.goto('/');
  await page.getByLabel('Message input').fill('/model qwen');
  await page.getByLabel('Message input').press('Enter');

  expect(streamCalls).toBe(0);
  await expect(page.getByRole('alert')).toContainText('/model is handled by Nelle UI');
  await expect(page.getByRole('alert')).toContainText('Use the model selector');
  await expect(page.getByLabel('Message input')).toContainText('/model qwen');
});

test('keeps the page frame fixed while only the chat region scrolls', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    presetName: 'unsloth-qwen',
    source: 'huggingface',
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
    hfRef: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/tmp/nelle',
    binaryPath: '/tmp/llama-server',
    installMode: 'external',
    installed: true,
    installedVersion: 'external:/tmp/llama-server',
    latestVersion: null,
    updateAvailable: false,
    running: true,
    pid: 123,
    host: '127.0.0.1',
    port: 8080,
    activeModelId: model.id,
    lastError: null,
  };
  const chat = Array.from({length: 36}, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Scrollable chat message ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 6, 7, 12, index)).toISOString(),
  }));

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat,
        },
        runtime,
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat});

  await page.goto('/');
  const chatLayout = page.getByTestId('chat-layout');
  await expect(page.getByLabel('Message input')).toBeVisible();

  const metrics = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    documentClientHeight: document.documentElement.clientHeight,
    documentScrollHeight: document.documentElement.scrollHeight,
  }));
  expect(metrics.bodyOverflow).toBe('hidden');
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.documentClientHeight + 1);
  await expect
    .poll(async () =>
      chatLayout.evaluate(element => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
    )
    .toMatchObject({
      clientHeight: expect.any(Number),
      scrollHeight: expect.any(Number),
    });

  const chatScrolls = await chatLayout.evaluate(
    element => element.scrollHeight > element.clientHeight,
  );
  expect(chatScrolls).toBe(true);
  const composerBoxBefore = await page.getByLabel('Message input').boundingBox();
  await chatLayout.evaluate(element => {
    element.scrollTop = 0;
  });
  const composerBoxAfter = await page.getByLabel('Message input').boundingBox();
  expect(composerBoxBefore).not.toBeNull();
  expect(composerBoxAfter).not.toBeNull();
  expect(Math.abs((composerBoxBefore?.y ?? 0) - (composerBoxAfter?.y ?? 0))).toBeLessThan(2);
});

test('virtualizes and collapses the conversation sidebar', async ({page}) => {
  const conversations = Array.from({length: 180}, (_, index) => ({
    id: index === 0 ? 'poc-default' : `chat-${index}`,
    title: `Chat ${String(index).padStart(3, '0')}`,
    titleSource: 'fallback',
    pinned: index < 3,
    status: index === 0 ? 'running' : 'ready',
    updatedAt: new Date(Date.UTC(2026, 6, 7, 12, index)).toISOString(),
  }));

  await mockConversationRoutes(page, {chat: [], conversations});

  await page.goto('/');

  await expect(page.getByTestId('conversation-section-pinned')).toBeVisible();
  await expect(page.getByTestId('conversation-section-recent')).toBeVisible();
  await expect(
    page.getByTestId('conversation-row-poc-default').getByText('running', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('conversation-row-poc-default')
      .getByRole('status', {name: 'Conversation running in progress'}),
  ).toBeVisible();
  await expect
    .poll(() => page.locator('[data-testid^="conversation-row-"]').count())
    .toBeLessThan(40);

  const conversationList = page.getByTestId('conversation-list');
  await conversationList.evaluate(element => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', {name: 'Chat 179', exact: true})).toBeVisible();

  await page.getByRole('button', {name: 'Collapse sidebar'}).click();
  await expect(page.getByRole('button', {name: 'Expand sidebar'})).toBeVisible();
  await expect(page.getByLabel('Search conversations')).toHaveCount(0);

  await page.getByRole('button', {name: 'Expand sidebar'}).click();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
});

test('deleting the last conversation leaves an empty sidebar', async ({page}) => {
  await mockConversationRoutes(page, {chat: []});
  page.on('dialog', dialog => void dialog.accept());

  await page.goto('/');
  await expect(page.getByTestId('conversation-row-poc-default')).toBeVisible();

  await page.getByRole('button', {name: 'Actions for POC chat'}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();

  // Conversation routes are mocked here, so this covers the client half only:
  // no conversation to send to means an empty sidebar and a blocked composer.
  // `syncPocConversationFromState` is covered by tests/unit/conversations.test.ts
  // and by the unmocked test below.
  await expect(page.getByTestId('conversation-row-poc-default')).toHaveCount(0);
  await expect(page.getByText('No chats yet')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Start a chat before sending a message.');
});

test('a deleted conversation is not recreated by the server', async ({page}) => {
  // Deliberately unmocked: this drives the real Fastify server and SQLite so it
  // catches `GET /api/conversations` re-inserting the conversation it lists.
  page.on('dialog', dialog => void dialog.accept());
  const rows = page.locator('[data-testid^="conversation-row-"]');

  await page.goto('/');
  await page.getByRole('button', {name: 'New chat'}).click();
  await expect(rows).toHaveCount(1);

  await page.getByRole('button', {name: /^Actions for /}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();

  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No chats yet')).toBeVisible();

  // Survives a fresh list request and a server-side startup sync.
  await page.reload();
  await expect(page.getByText('No chats yet')).toBeVisible();
  await expect(rows).toHaveCount(0);
});

test('stops re-requesting model props after llama.cpp rejects the call', async ({page}) => {
  const model = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {...RUNNING_RUNTIME, activeModelId: model.id};
  let propsCalls = 0;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {state: {activeModelId: model.id, models: [model], chat: []}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            // A sleeping model is "runnable", but llama.cpp answers /props with
            // an error while it is asleep.
            status: 'sleeping',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await page.route('**/api/llama/models/**/props', async route => {
    propsCalls += 1;
    await route.fulfill({
      status: 500,
      json: {error: {code: 'llama_props_failed', message: 'model is asleep'}},
    });
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await expect(page.getByText('sleeping', {exact: true}).last()).toBeVisible();

  // A failed props response must be cached, not retried on every render.
  await page.waitForTimeout(1500);
  const settledCalls = propsCalls;
  expect(settledCalls).toBeLessThanOrEqual(2);

  await page.waitForTimeout(1500);
  expect(propsCalls).toBe(settledCalls);
});

test('keeps the composer opaque and interactive while a run streams', async ({page}) => {
  const model = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {...RUNNING_RUNTIME, activeModelId: model.id};
  let releaseStream: () => void = () => {};
  const streamReleased = new Promise<void>(resolve => {
    releaseStream = resolve;
  });

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {state: {activeModelId: model.id, models: [model], chat: []}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/llama/models', async route => {
    await route.fulfill({
      json: {
        models: [
          {
            sectionId: model.id,
            routerModelId: model.id,
            alias: model.name,
            hfRepo: model.hfRef,
            status: 'loaded',
            aliases: [model.id],
          },
        ],
      },
    });
  });
  await mockConversationRoutes(page, {chat: [], onAbort: () => releaseStream()});
  await page.route('**/api/conversations/poc-default/chat/stream', async route => {
    await streamReleased;
    await route
      .fulfill({headers: {'content-type': 'text/event-stream; charset=utf-8'}, body: ''})
      .catch(() => undefined);
  });

  await page.goto('/');

  const opacityOf = (selector: string) =>
    page.locator(selector).evaluate(element => getComputedStyle(element).opacity);
  const composer = '.nelle-chat-composer';

  // The dock paints an opaque backdrop so the transcript never bleeds through.
  const dockBackground = await page
    .locator('.nelle-chat-layout > *:has(.nelle-chat-composer)')
    .evaluate(element => getComputedStyle(element).backgroundColor);
  expect(dockBackground).not.toContain('rgba');
  expect(dockBackground).not.toBe('transparent');

  await page.getByLabel('Message input').fill('stream something');
  await page.getByLabel('Message input').press('Enter');

  const stopButton = page.getByRole('button', {name: 'Stop'});
  await expect(stopButton).toBeVisible();
  // Astryx dims and disables pointer events on a disabled composer; a streaming
  // composer must stay fully opaque so stop is clickable and nothing shows through.
  expect(await opacityOf(composer)).toBe('1');
  expect(
    await page.locator(composer).evaluate(element => getComputedStyle(element).pointerEvents),
  ).not.toBe('none');

  await stopButton.click();
  await expect(page.getByRole('button', {name: 'Send'})).toBeVisible();
});

const RUNNING_RUNTIME = {
  platform: 'linux',
  arch: 'x64',
  dataDir: '/tmp/nelle',
  binaryPath: '/tmp/llama-server',
  logPath: '/tmp/llama.log',
  installMode: 'external',
  installed: true,
  installedVersion: 'external:/tmp/llama-server',
  latestVersion: null,
  updateAvailable: false,
  running: true,
  pid: 123,
  host: '127.0.0.1',
  port: 8080,
  modelsMax: 1,
  sleepIdleSeconds: 90,
  activeModelId: null as string | null,
  lastError: null,
};

async function mockConversationRoutes(
  page: Page,
  input: {
    chat: MockChatMessage[];
    conversations?: MockConversation[];
    importedChat?: MockChatMessage[];
    onCompact?: (instructions?: string) => void;
    onClone?: (conversationId: string, body: {entryId?: string; title?: string}) => void;
    onFork?: (conversationId: string, body: {entryId: string; title?: string}) => void;
    onExport?: (conversationId: string) => void;
    onImport?: () => void;
    abortWarning?: {code: string; message: string};
    onAbort?: () => void;
  },
): Promise<void> {
  let chat = input.chat;
  const contextByConversation = new Map<string, ReturnType<typeof contextFromChat>>();
  let conversations = input.conversations ?? [
    {
      id: 'poc-default',
      title: chat[0]?.content.slice(0, 80) || 'POC chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T12:00:00.000Z',
    },
  ];

  await page.route('**/api/conversations**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname.endsWith('/chat/stream') || pathname.endsWith('/regenerate')) {
      await route.fallback();
      return;
    }
    if (pathname === '/api/conversations/poc-default/abort' && request.method() === 'POST') {
      input.onAbort?.();
      await route.fulfill({
        json: {
          ok: true,
          aborted: true,
          warning: input.abortWarning,
          snapshot: conversationSnapshot('poc-default', chat),
        },
      });
      return;
    }
    const runAbortMatch = pathname.match(
      /^\/api\/conversations\/poc-default\/runs\/([^/]+)\/abort$/,
    );
    if (runAbortMatch && request.method() === 'POST') {
      input.onAbort?.();
      await route.fulfill({
        json: {
          ok: true,
          aborted: true,
          runId: decodeURIComponent(runAbortMatch[1]!),
          warning: input.abortWarning,
          snapshot: conversationSnapshot('poc-default', chat),
        },
      });
      return;
    }
    if (pathname === '/api/conversations/import' && request.method() === 'POST') {
      input.onImport?.();
      chat = input.importedChat ?? [];
      const conversation = {
        id: 'imported-chat',
        title: 'Imported chat',
        titleSource: 'imported',
        pinned: false,
        status: 'ready',
        updatedAt: '2026-07-07T12:05:00.000Z',
      };
      conversations = [conversation, ...conversations];
      await route.fulfill({
        json: {
          conversation,
          snapshot: conversationSnapshot(conversation.id, chat, conversation),
        },
      });
      return;
    }
    if (
      pathname === '/api/conversations/poc-default/compact/stream' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON() as {instructions?: string} | null;
      input.onCompact?.(body?.instructions);
      const runId = 'run-compact-e2e';
      const createdAt = '2026-07-07T12:04:00.000Z';
      const compactedContext = {
        usedTokens: 73,
        totalTokens: 8192,
        source: 'estimate',
        updatedAt: createdAt,
      };
      contextByConversation.set('poc-default', compactedContext);
      const events = [
        {
          type: 'run.started',
          runId,
          conversationId: 'poc-default',
          kind: 'compact',
          modelId: 'model-1',
          status: 'running',
          createdAt,
        },
        {
          type: 'compact.started',
          runId,
          conversationId: 'poc-default',
          instructions: body?.instructions,
          createdAt,
        },
        {
          type: 'context.updated',
          conversationId: 'poc-default',
          ...compactedContext,
          createdAt,
        },
        {
          type: 'compact.completed',
          runId,
          conversationId: 'poc-default',
          compacted: true,
          createdAt,
        },
        {
          type: 'run.completed',
          runId,
          conversationId: 'poc-default',
          status: 'completed',
          createdAt,
        },
      ];
      await route.fulfill({
        headers: {'content-type': 'text/event-stream; charset=utf-8'},
        body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
      return;
    }
    if (pathname === '/api/conversations/poc-default/compact' && request.method() === 'POST') {
      const body = request.postDataJSON() as {instructions?: string} | null;
      input.onCompact?.(body?.instructions);
      await route.fulfill({
        json: {
          ok: true,
          compacted: true,
          snapshot: conversationSnapshot('poc-default', chat),
        },
      });
      return;
    }
    if (
      pathname === '/api/conversations/poc-default/compact/abort' &&
      request.method() === 'POST'
    ) {
      await route.fulfill({
        json: {
          ok: true,
          aborted: false,
          snapshot: conversationSnapshot('poc-default', chat),
        },
      });
      return;
    }
    const exportMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/export$/);
    if (exportMatch && request.method() === 'POST') {
      input.onExport?.(decodeURIComponent(exportMatch[1]!));
      await route.fulfill({
        status: 200,
        headers: {'content-type': 'application/zip'},
        body: Buffer.from('mock archive'),
      });
      return;
    }
    const cloneMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/clone$/);
    if (cloneMatch && request.method() === 'POST') {
      const sourceConversationId = decodeURIComponent(cloneMatch[1]!);
      const body = (request.postDataJSON() ?? {}) as {entryId?: string; title?: string};
      input.onClone?.(sourceConversationId, body);
      const source = conversations.find(conversation => conversation.id === sourceConversationId);
      const conversation = {
        id: `${sourceConversationId}-copy`,
        title: body.title ?? `${source?.title ?? 'POC chat'} (copy)`,
        titleSource: 'fallback',
        pinned: false,
        status: 'ready',
        updatedAt: '2026-07-07T12:02:00.000Z',
      };
      conversations = [conversation, ...conversations];
      await route.fulfill({
        json: {
          conversation,
          snapshot: conversationSnapshot(conversation.id, chat, conversation),
        },
      });
      return;
    }
    const forkMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/fork$/);
    if (forkMatch && request.method() === 'POST') {
      const sourceConversationId = decodeURIComponent(forkMatch[1]!);
      const body = request.postDataJSON() as {entryId: string; title?: string};
      input.onFork?.(sourceConversationId, body);
      const source = conversations.find(conversation => conversation.id === sourceConversationId);
      const entryIndex = chat.findIndex(message => message.id === body.entryId);
      chat = entryIndex >= 0 ? chat.slice(0, entryIndex + 1) : chat;
      const conversation = {
        id: `${sourceConversationId}-fork`,
        title: body.title ?? `${source?.title ?? 'POC chat'} (fork)`,
        titleSource: 'fallback',
        pinned: false,
        status: 'ready',
        updatedAt: '2026-07-07T12:03:00.000Z',
      };
      conversations = [conversation, ...conversations];
      await route.fulfill({
        json: {
          conversation,
          snapshot: conversationSnapshot(conversation.id, chat, conversation),
        },
      });
      return;
    }
    if (pathname === '/api/conversations' && request.method() === 'GET') {
      await route.fulfill({json: {conversations}});
      return;
    }
    if (pathname === '/api/conversations' && request.method() === 'DELETE') {
      conversations = [];
      chat = [];
      await route.fulfill({json: {ok: true, cleanup: {}}});
      return;
    }
    if (pathname === '/api/conversations' && request.method() === 'POST') {
      const conversation = {
        id: 'new-chat',
        title: 'New chat',
        titleSource: 'fallback',
        pinned: false,
        status: 'ready',
        updatedAt: '2026-07-07T12:00:00.000Z',
      };
      conversations = [conversation, ...conversations];
      chat = [];
      await route.fulfill({json: {conversation}});
      return;
    }
    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationMatch && request.method() === 'GET') {
      const conversationId = decodeURIComponent(conversationMatch[1]!);
      await route.fulfill({
        json: {
          snapshot: conversationSnapshot(
            conversationId,
            chat,
            conversations.find(conversation => conversation.id === conversationId),
            contextByConversation.get(conversationId),
          ),
        },
      });
      return;
    }
    if (conversationMatch && request.method() === 'DELETE') {
      const conversationId = decodeURIComponent(conversationMatch[1]!);
      conversations = conversations.filter(conversation => conversation.id !== conversationId);
      chat = [];
      await route.fulfill({json: {ok: true, cleanup: {}}});
      return;
    }
    if (pathname.endsWith('/messages') && request.method() === 'DELETE') {
      chat = [];
      await route.fulfill({json: {ok: true}});
      return;
    }
    await route.fallback();
  });
}

function conversationSnapshot(
  id: string,
  chat: MockChatMessage[],
  conversation?: MockConversation,
  context?: ReturnType<typeof contextFromChat>,
) {
  const attachments = chat.flatMap(message =>
    (message.attachments ?? []).map(attachment => ({
      ...attachment,
      conversationId: id,
      piEntryId: message.id,
    })),
  );
  return {
    conversation: {
      id,
      title: conversation?.title ?? chat[0]?.content.slice(0, 80) ?? 'POC chat',
      titleSource: conversation?.titleSource ?? 'fallback',
      pinned: conversation?.pinned ?? false,
      status: conversation?.status ?? 'ready',
      createdAt: '2026-07-07T12:00:00.000Z',
      updatedAt: conversation?.updatedAt ?? '2026-07-07T12:00:00.000Z',
    },
    entries: chat.map((message, index) => ({
      conversationId: id,
      piEntryId: message.id,
      parentPiEntryId: index > 0 ? chat[index - 1]?.id : undefined,
      entryType: 'message',
      role: message.role,
      textPreview: message.content,
      createdAt: message.createdAt,
      performance: message.performance,
      toolCalls: message.toolCalls,
      modelId: message.modelId,
      modelRuntimeId: message.modelRuntimeId,
      modelAliasSnapshot: message.modelAliasSnapshot,
      regeneratesPiEntryId: message.regeneratesPiEntryId,
      displayGroupId: message.displayGroupId,
    })),
    activePathEntryIds: chat.map(message => message.id),
    attachments,
    context: context ?? contextFromChat(chat),
    models: {available: []},
    capabilities: {
      canSend: true,
      canAbort: false,
      canCompact: chat.length > 0,
      canFork: chat.length > 0,
      canAttachImages: false,
      canAttachText: true,
    },
    errors: [],
  };
}

function contextFromChat(chat: MockChatMessage[]) {
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index];
    const performance = message?.performance as
      | {
          prompt?: {tokens?: number; totalTokens?: number};
          generation?: {tokens?: number};
        }
      | undefined;
    const promptTokens = performance?.prompt?.totalTokens ?? performance?.prompt?.tokens;
    if (message?.role === 'assistant' && promptTokens != null) {
      return {
        usedTokens: promptTokens + (performance?.generation?.tokens ?? 0),
        totalTokens: 8192,
        source: 'timings',
        updatedAt: message.createdAt,
      };
    }
  }
  return {};
}

function simplePdfBuffer(text: string): Buffer {
  const escapedText = text.replace(/[()\\]/g, value => `\\${value}`);
  const stream = `BT /F1 18 Tf 32 90 Td (${escapedText}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

type MockChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  attachments?: MockAttachment[];
  performance?: unknown;
  toolCalls?: unknown;
  modelId?: string;
  modelRuntimeId?: string;
  modelAliasSnapshot?: string;
  regeneratesPiEntryId?: string;
  displayGroupId?: string;
};

type MockAttachment = {
  id: string;
  conversationId: string;
  piEntryId?: string;
  uploadId?: string;
  kind: 'text' | 'pdf' | 'image';
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  textPreview?: string;
  createdAt: string;
};

type MockAttachmentRequest = {
  id: string;
  kind: 'text' | 'pdf' | 'image';
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  text?: string;
  data?: string;
};

type MockConversation = {
  id: string;
  title: string;
  titleSource: string;
  pinned: boolean;
  status: string;
  updatedAt: string;
};
