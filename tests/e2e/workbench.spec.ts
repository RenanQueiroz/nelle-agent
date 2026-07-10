import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test, type Page, type Route} from '@playwright/test';

import {withContextStatus} from '../../packages/shared/src/context.ts';
import {imageOnlyPdfBuffer, simplePdfBuffer} from '../unit/helpers/pdf.ts';
import {buildConversationMessages} from '../../packages/shared/src/messages.ts';

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

  // `[*]` carries only `fitc`, a floor for llama.cpp's auto-fit. Nelle writes no
  // context size at all; capping one is the user's to type, in a new row.
  await page.getByRole('button', {name: 'Global Params'}).click();
  await expect(page.getByLabel('Key').first()).toHaveValue('fitc');
  await page.getByRole('button', {name: 'Add parameter'}).click();
  await page.getByLabel('Key').nth(1).fill('c');
  await page.getByLabel('Value').nth(1).fill('12288');
  await page.getByRole('button', {name: 'Save global params'}).click();
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('c = 12288');

  // Editing straight after a save must survive the refresh that save triggers.
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
  let savedFavorites: string[] = [];
  await page.route('**/api/settings/preferences', async route => {
    if (route.request().method() === 'PATCH') {
      savedFavorites = (route.request().postDataJSON() as {favoriteModelIds: string[]})
        .favoriteModelIds;
    }
    await route.fulfill({json: {favoriteModelIds: savedFavorites}});
  });

  await page.goto('/');

  const composerModelButton = page.getByRole('button', {name: 'Model', exact: true});
  await expect(composerModelButton).toContainText('Model A');
  await expect(page.getByText('loaded', {exact: true}).last()).toBeVisible();

  await page.getByRole('button', {name: 'Favorite model'}).click();
  await expect(page.getByRole('button', {name: 'Unfavorite model'})).toBeVisible();
  // Favorites are stored on the server, so they follow the user to another client.
  await expect.poll(() => savedFavorites).toEqual([modelA.id]);

  await composerModelButton.click();
  await expect(page.getByText('Favorites')).toBeVisible();
  await page.getByPlaceholder('Search models').fill('Model B');
  await page.getByRole('option', {name: /Model B/}).click();

  await expect.poll(() => loadCalls).toBe(1);
  await expect.poll(() => activateCalls).toBe(1);
  await expect(composerModelButton).toContainText('Model B');
  await expect(page.getByText('loaded', {exact: true}).last()).toBeVisible();
});

test('the server loads an unloaded model and the client renders its progress', async ({page}) => {
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
  let releaseStream: (() => void) | undefined;
  const streamGate = new Promise<void>(resolve => {
    releaseStream = resolve;
  });
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
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
    // Hold the response open after the load events so the placeholder is
    // observable, exactly as a real server-side load would.
    await streamGate;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {
          type: 'model.loading',
          conversationId: 'legacy-default',
          modelId: model.id,
          status: 'loading',
          progress: 0.42,
          createdAt: '2026-07-07T12:01:00.000Z',
        },
        {type: 'message.user.created', message: userMessage},
        {
          type: 'message.assistant.started',
          harness: 'pi',
          message: {...assistantMessage, content: ''},
        },
        {type: 'message.assistant.delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'message.assistant.completed', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  const composerModelButton = page.getByRole('button', {name: 'Model', exact: true});
  await expect(composerModelButton).toContainText('Model A');
  await expect(page.getByText('unloaded', {exact: true}).last()).toBeVisible();

  await fillComposer(page, 'hello after eviction');
  await page.getByLabel('Message input').press('Enter');

  // The prompt and a load placeholder appear while the server waits for weights.
  await expect(page.getByText('Loading weights')).toBeVisible();
  releaseStream?.();

  await expect.poll(() => streamCalls).toBe(1);
  await expect(page.getByText('Loaded before chat.')).toBeVisible();

  // The client no longer loads or polls. The run does it, and says so.
  expect(loadCalls, 'the client must not post a load itself').toBe(0);
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: `data: ${JSON.stringify({
        type: 'run.started',
        runId: 'run-model-lock',
        conversationId: 'legacy-default',
        kind: 'chat',
        modelId: model.id,
        status: 'running',
        createdAt: '2026-07-07T12:01:00.000Z',
      })}\n\n`,
    });
  });

  await page.goto('/');
  await fillComposer(page, 'hold this model');
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: [
        {
          type: 'run.started',
          runId: 'run-model-lock',
          conversationId: 'legacy-default',
          kind: 'chat',
          modelId: model.id,
          status: 'running',
          createdAt: '2026-07-07T12:01:00.000Z',
        },
        {
          type: 'run.aborted',
          runId: 'run-model-lock',
          conversationId: 'legacy-default',
          reason: 'user',
          createdAt: '2026-07-07T12:01:01.000Z',
        },
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await fillComposer(page, 'abort this run');
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    await streamReleased;
    await route
      .fulfill({
        headers: {'content-type': 'text/event-stream; charset=utf-8'},
        body: '',
      })
      .catch(() => undefined);
  });

  await page.goto('/');
  await fillComposer(page, 'stop this run');
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
      id: 'legacy-default',
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls.push('legacy-default');
    conversations[0]!.status = 'running';
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: `data: ${JSON.stringify({
        type: 'run.started',
        runId: 'run-primary',
        conversationId: 'legacy-default',
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
  await fillComposer(page, 'start primary run');
  await page.getByLabel('Message input').press('Enter');
  await expect.poll(() => streamCalls).toContainEqual('legacy-default');
  await expect(
    page.getByTestId('conversation-row-legacy-default').getByText('running', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('conversation-row-legacy-default')
      .getByRole('status', {name: 'Conversation running in progress'}),
  ).toBeVisible();

  await page.getByRole('button', {name: 'Second chat', exact: true}).click();
  await expect(page.getByLabel('Message input')).toBeEnabled();
  await fillComposer(page, 'start second run');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toEqual(['legacy-default', 'second-chat']);
  await expect(
    page.getByTestId('conversation-row-legacy-default').getByText('running', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('conversation-row-legacy-default')
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
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
        {type: 'message.user.created', message: userMessage},
        {
          type: 'message.assistant.started',
          harness: 'llamacpp',
          message: {...assistantMessage, content: '', performance: undefined},
        },
        {type: 'message.assistant.delta', id: assistantMessage.id, delta: assistantMessage.content},
        {
          type: 'performance.updated',
          id: assistantMessage.id,
          performance: assistantMessage.performance,
        },
        // The server, not the client, turns performance into a context reading.
        {
          type: 'context.updated',
          conversationId: 'legacy-default',
          usedTokens: 134,
          totalTokens: 8192,
          source: 'timings',
          status: 'ok',
          createdAt: new Date().toISOString(),
        },
        {type: 'message.assistant.completed', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await fillComposer(page, 'hello');
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
  // `/api/uploads` is deliberately not mocked: the bytes go to the real e2e
  // server, which classifies them and hands back an id.
  let uploadCalls = 0;
  let uploadDeletes = 0;
  page.on('request', request => {
    if (!request.url().includes('/api/uploads')) {
      return;
    }
    if (request.method() === 'POST') {
      uploadCalls += 1;
    }
    if (request.method() === 'DELETE') {
      uploadDeletes += 1;
    }
  });
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
    requestBody = route.request().postDataJSON() as {
      message?: string;
      attachments?: MockAttachmentRequest[];
    };
    // The real server reads the upload and binds its metadata to the user turn.
    const userAttachments = (requestBody.attachments ?? []).map((attachment, index) => ({
      id: `attachment-${index}`,
      conversationId: 'legacy-default',
      piEntryId: 'user-1',
      uploadId: attachment.uploadId,
      kind: 'text',
      name: 'attachment-note.txt',
      mimeType: 'text/plain',
      sizeBytes: 64,
      textPreview: 'Router mode should load models on demand.',
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
        {type: 'message.user.created', message: userMessage},
        {
          type: 'message.assistant.started',
          harness: 'pi',
          message: {...assistantMessage, content: ''},
        },
        {type: 'message.assistant.delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'message.assistant.completed', message: assistantMessage},
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

  // Removing an attachment takes it out of the draft, not just off the screen:
  // the drawer unmounts once the last one is gone, and the bytes leave the
  // server rather than waiting for the retention sweep.
  await page.getByTestId('attachment-drawer').locator('.astryx-token button').first().click();
  await expect(page.getByTestId('attachment-drawer')).toHaveCount(0);
  await expect.poll(() => uploadDeletes).toBe(1);

  await page.locator('input[aria-label="Attach files"]').setInputFiles(textFilePath);
  await expect(page.getByTestId('attachment-drawer')).toContainText('attachment-note.txt');
  await fillComposer(page, 'summarize this file');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toBe(1);
  // The bytes went to the real `POST /api/uploads`; the message carries only a
  // reference, and none of the payload the browser used to extract itself.
  expect(uploadCalls).toBe(2);
  expect(requestBody?.attachments).toHaveLength(1);
  expect(requestBody?.attachments?.[0]?.uploadId).toBeTruthy();
  expect(Object.keys(requestBody?.attachments?.[0] ?? {})).toEqual(['uploadId']);
  await expect(page.getByText('I read the attachment.')).toBeVisible();
  await expect(page.getByText('attachment-note.txt')).toBeVisible();
});

test('a text PDF is sent as text and a scan as page images, with no switch', async ({page}) => {
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
  const scanPath = path.join(repoRoot, '.nelle-e2e', 'vision-attachment-scan.pdf');
  await fs.mkdir(path.dirname(pdfPath), {recursive: true});
  await fs.writeFile(pdfPath, simplePdfBuffer('This PDF has a text layer'));
  // No text layer at all: page images are the only way to read it.
  await fs.writeFile(scanPath, imageOnlyPdfBuffer());

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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
    requestBody = route.request().postDataJSON() as {
      message?: string;
      attachments?: MockAttachmentRequest[];
    };
    // The server renders the pages, so the bound metadata is one image per page.
    const userAttachments = (requestBody.attachments ?? []).map((attachment, index) => ({
      id: `attachment-${index}`,
      conversationId: 'legacy-default',
      piEntryId: 'user-1',
      uploadId: attachment.uploadId,
      kind: 'image',
      name: 'vision-attachment page 1.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
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
        {type: 'message.user.created', message: userMessage},
        {
          type: 'message.assistant.started',
          harness: 'pi',
          message: {...assistantMessage, content: ''},
        },
        {type: 'message.assistant.delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'message.assistant.completed', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  // Nothing is attached, so there is no drawer -- and there is no switch anywhere.
  await expect(page.getByTestId('attachment-drawer')).toHaveCount(0);
  await expect(page.getByLabel('Render PDFs as images')).toHaveCount(0);

  // The real `POST /api/uploads` reads the document. A text layer means the model
  // gets the text: cheap, exact, and no vision required.
  await page.locator('input[aria-label="Attach files"]').setInputFiles(pdfPath);
  await expect(page.getByTestId('attachment-drawer')).toContainText('vision-attachment.pdf');
  await expect(page.getByTestId('attachment-drawer')).toContainText('PDF text');
  await expect(page.getByLabel('Render PDFs as images')).toHaveCount(0);
  await page.getByTestId('attachment-drawer').locator('.astryx-token button').first().click();
  await expect(page.getByTestId('attachment-drawer')).toHaveCount(0);

  // A scan has no text to send, so the chip says what will actually be sent.
  await page.locator('input[aria-label="Attach files"]').setInputFiles(scanPath);
  await expect(page.getByTestId('attachment-drawer')).toContainText('vision-attachment-scan.pdf');
  await expect(page.getByTestId('attachment-drawer')).toContainText('PDF pages');
  await expect(page.getByLabel('Render PDFs as images')).toHaveCount(0);

  await fillComposer(page, 'describe this PDF');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toBe(1);
  // A reference, and nothing else. The rendering decision is not the client's.
  expect(requestBody?.attachments).toHaveLength(1);
  expect(Object.keys(requestBody?.attachments?.[0] ?? {})).toEqual(['uploadId']);
  await expect(page.getByText('I can see the rendered PDF page.')).toBeVisible();
  await expect(page.getByText('vision-attachment page 1.png')).toBeVisible();
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
    '**/api/conversations/legacy-default/messages/assistant-1/regenerate',
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
          {type: 'message.user.created', message: regeneratedUser},
          {
            type: 'message.assistant.started',
            harness: 'pi',
            message: {...regeneratedAssistant, content: ''},
          },
          {
            type: 'message.assistant.delta',
            id: regeneratedAssistant.id,
            delta: regeneratedAssistant.content,
          },
          {type: 'message.assistant.completed', message: regeneratedAssistant},
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

  await expect.poll(() => regenerateCalls).toBe(1);
  expect(regenerateModelId).toBe(modelB.id);
  // The regenerate route loads the override model server-side; the client only
  // names it.
  expect(loadCalls, 'the client must not post a load itself').toBe(0);
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
        id: 'legacy-default',
        title: 'Legacy chat',
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

  await page.getByRole('button', {name: 'Actions for Legacy chat'}).click();
  await page.getByRole('menuitem', {name: 'Duplicate'}).click();

  await expect.poll(() => cloneCalls).toBe(1);
  await expect(page.getByRole('button', {name: 'Legacy chat (copy)', exact: true})).toBeVisible();
  await expect(page.getByText('Conversation duplicated.')).toBeVisible();

  await page.getByRole('button', {name: 'Fork from here'}).click();

  await expect.poll(() => forkCalls).toBe(1);
  expect(forkEntryId).toBe('user-1');
  await expect(
    page.getByRole('button', {name: 'Legacy chat (copy) (fork)', exact: true}),
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
        id: 'legacy-default',
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
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
        {type: 'message.user.created', message: userMessage},
        {
          type: 'message.assistant.started',
          harness: 'pi',
          message: {...assistantMessage, content: '', toolCalls: []},
        },
        {type: 'tool_call.updated', call: runningCall},
        {type: 'tool_call.updated', call: completedCall},
        {type: 'message.assistant.delta', id: assistantMessage.id, delta: assistantMessage.content},
        {type: 'message.assistant.completed', message: assistantMessage},
      ]
        .map(event => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto('/');
  await fillComposer(page, 'run a command');
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: '',
    });
  });

  await page.goto('/');
  await fillComposer(page, '/');
  await expect(
    page.getByRole('option', {name: /compact Compact this conversation context/}),
  ).toBeVisible();
  await fillComposer(page, '/compact keep file names');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => compactCalls).toBe(1);
  expect(streamCalls).toBe(0);
  await expect(page.getByText('completed')).toBeVisible();
  await expect(page.getByText('Conversation compacted.')).toBeVisible();
  await page.getByTestId('composer-context-progress').hover();
  await expect(page.getByText('Context: 73 / 8,192 tokens')).toBeVisible();
});

test('favorites starred in the browser are handed to the server once', async ({page}) => {
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
  const patched: Array<string[]> = [];
  // The server has nothing yet; the browser is the only place these exist.
  let stored: string[] = [];

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {state: {activeModelId: model.id, models: [model], chat: []}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat: []});
  await page.route('**/api/settings/preferences', async route => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as {favoriteModelIds: string[]};
      patched.push(body.favoriteModelIds);
      stored = body.favoriteModelIds;
    }
    await route.fulfill({json: {favoriteModelIds: stored}});
  });

  await page.goto('/');
  // Nothing to hand over, so nothing is written.
  await expect(page.getByRole('button', {name: 'Favorite model'})).toBeVisible();
  expect(patched).toHaveLength(0);

  // A browser that starred a model before favorites moved to the server.
  await page.evaluate(() => {
    window.localStorage.setItem('nelle.favoriteModelIds', JSON.stringify(['model-1']));
  });
  await page.reload();

  await expect.poll(() => patched).toEqual([['model-1']]);
  // The local copy is surrendered, so the next load does not re-upload it and a
  // favorite removed on another client cannot come back from this browser.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('nelle.favoriteModelIds')))
    .toBe(null);

  await page.reload();
  await expect(page.getByRole('button', {name: 'Unfavorite model'})).toBeVisible();
  expect(patched).toHaveLength(1);
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: '',
    });
  });

  // The refusal copy comes from the server's registry, not a table in the bundle.
  await page.route('**/api/commands', async route => {
    await route.fulfill({
      json: {
        commands: [{name: '/compact', argHint: '[instructions]', description: 'Compact'}],
        unsupported: [{name: '/model', guidance: 'Pick a model from the composer selector.'}],
      },
    });
  });

  await page.goto('/');
  await fillComposer(page, '/model qwen');
  await page.getByLabel('Message input').press('Enter');

  expect(streamCalls).toBe(0);
  await expect(page.getByRole('alert')).toContainText('/model is handled by Nelle UI');
  await expect(page.getByRole('alert')).toContainText('Pick a model from the composer selector.');
  await expect(page.getByLabel('Message input')).toContainText('/model qwen');
});

test('a command the server allowlists is sent, without a client release', async ({page}) => {
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
      json: {state: {activeModelId: model.id, models: [model], chat: []}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat: []});
  await page.route('**/api/commands', async route => {
    await route.fulfill({
      json: {
        // `/summarise` exists only in this response. The bundled registry does
        // not know it, and the client must not refuse it anyway.
        commands: [
          {name: '/compact', argHint: '[instructions]', description: 'Compact'},
          {name: '/summarise', description: 'Summarise this conversation'},
        ],
        unsupported: [{name: '/model', guidance: 'Use the model selector.'}],
      },
    });
  });
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: '',
    });
  });

  await page.goto('/');
  await fillComposer(page, '/summarise the thread');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => streamCalls).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
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
    id: index === 0 ? 'legacy-default' : `chat-${index}`,
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
    page.getByTestId('conversation-row-legacy-default').getByText('running', {exact: true}),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('conversation-row-legacy-default')
      .getByRole('status', {name: 'Conversation running in progress'}),
  ).toBeVisible();
  await expect
    .poll(() => page.locator('[data-testid^="conversation-row-"]').count())
    .toBeLessThan(40);

  // 177 unpinned conversations, even though only the first page is loaded. The
  // header must count the list, not the scroll window.
  await expect(page.getByTestId('conversation-section-recent')).toContainText('177');

  const conversationList = page.getByTestId('conversation-list');
  const scrollToBottom = async () => {
    await conversationList.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
  };

  // Newest first, so page one holds Chat 179. Chat 003 is the oldest unpinned
  // conversation and sits three pages down; it can only appear if the sidebar
  // asks the server for the next page.
  await expect(page.getByRole('button', {name: 'Chat 179', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Chat 003', exact: true})).toHaveCount(0);

  await expect(async () => {
    await scrollToBottom();
    await expect(page.getByRole('button', {name: 'Chat 003', exact: true})).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({timeout: 15_000});

  // Paging in every conversation must not mount every row.
  await expect
    .poll(() => page.locator('[data-testid^="conversation-row-"]').count())
    .toBeLessThan(40);

  await page.getByRole('button', {name: 'Collapse sidebar'}).click();
  await expect(page.getByRole('button', {name: 'Expand sidebar'})).toBeVisible();
  await expect(page.getByLabel('Search conversations')).toHaveCount(0);

  // The collapsed rail is ~48px. A horizontal footer row pushed the expand
  // button off the left edge of the screen, leaving only a sliver clickable.
  const rail = await page.getByTestId('nelle-side-nav').boundingBox();
  for (const name of ['Expand sidebar', 'New chat', 'Settings']) {
    const button = await page.getByRole('button', {name, exact: true}).boundingBox();
    expect(button, `${name} should be rendered while collapsed`).not.toBeNull();
    expect(button!.x, `${name} escapes the collapsed rail`).toBeGreaterThanOrEqual(rail!.x);
    expect(button!.x + button!.width, `${name} escapes the collapsed rail`).toBeLessThanOrEqual(
      rail!.x + rail!.width + 1,
    );
  }

  await page.getByRole('button', {name: 'Expand sidebar'}).click();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
});

test('conversation search finds a chat that is not on the first page', async ({page}) => {
  // The needle is the oldest conversation, so it is nowhere near the loaded
  // page. A sidebar that filters its own rows would report "No matching chats".
  const conversations = [
    ...Array.from({length: 120}, (_, index) => ({
      id: index === 0 ? 'legacy-default' : `chat-${index}`,
      title: `Haystack ${String(index).padStart(3, '0')}`,
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: new Date(Date.UTC(2026, 6, 7, 12, index + 1)).toISOString(),
    })),
    {
      id: 'needle',
      title: 'Needle conversation',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: new Date(Date.UTC(2026, 6, 7, 11, 0)).toISOString(),
    },
  ];

  await mockConversationRoutes(page, {chat: [], conversations});
  await page.goto('/');

  await expect(page.getByTestId('conversation-section-recent')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Needle conversation', exact: true})).toHaveCount(0);

  await page.getByLabel('Search conversations').fill('Needle');

  await expect(page.getByRole('button', {name: 'Needle conversation', exact: true})).toBeVisible();
  await expect(page.getByTestId('conversation-section-results')).toContainText('1');
});

test('an unavailable conversation offers repair, rebuild, and delete', async ({page}) => {
  const recoveries: Array<[string, string]> = [];
  await mockConversationRoutes(page, {
    chat: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Saved in SQLite',
        createdAt: '2026-07-07T12:00:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'legacy-default',
        title: 'Broken chat',
        titleSource: 'fallback',
        pinned: false,
        status: 'unavailable',
        updatedAt: '2026-07-07T12:00:00.000Z',
      },
    ],
    onRecover: (conversationId, action) => recoveries.push([conversationId, action]),
  });
  page.on('dialog', dialog => void dialog.accept());

  await page.goto('/');

  // The transcript is replaced by the recovery panel, which names the file.
  const panel = page.getByTestId('conversation-unavailable');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Pi session file is missing.');
  await expect(panel).toContainText('/data/pi/sessions/legacy-default.jsonl');
  await expect(panel).toContainText('1 message');

  // Sending is blocked, and the composer says why rather than "start a chat".
  await expect(
    page.getByText('This conversation cannot be opened. Repair it, rebuild it from saved messages'),
  ).toBeVisible();

  // Repair first: the file is still gone, so it fails and the panel stays.
  await panel.getByRole('button', {name: 'Repair', exact: true}).click();
  await expect.poll(() => recoveries).toEqual([['legacy-default', 'repair']]);
  await expect(panel).toBeVisible();

  // Rebuild is confirmed, then reconstructs the conversation from SQLite.
  await panel.getByRole('button', {name: 'Rebuild from saved messages'}).click();
  await expect.poll(() => recoveries.length).toBe(2);
  expect(recoveries[1]).toEqual(['legacy-default', 'rebuild']);
  await expect(page.getByTestId('conversation-unavailable')).toHaveCount(0);
  await expect(page.getByText('Saved in SQLite')).toBeVisible();
});

test('a refused message keeps its text and its attachments', async ({page}) => {
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
  const notePath = path.join(repoRoot, '.nelle-e2e', 'refused-note.txt');
  await fs.mkdir(path.dirname(notePath), {recursive: true});
  await fs.writeFile(notePath, 'A note the server will refuse to send.');

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {state: {activeModelId: model.id, models: [model], chat: []}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat: []});
  // Refused before it ever becomes a turn: an `error` event and no `run.started`.
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: `data: ${JSON.stringify({
        type: 'error',
        code: 'unsupported_attachment',
        message: 'scan.pdf has no text layer, so its 6 pages must be read as images.',
        retryable: false,
      })}\n\n`,
    });
  });

  await page.goto('/');
  await page.locator('input[aria-label="Attach files"]').setInputFiles(notePath);
  await expect(page.getByTestId('attachment-drawer')).toContainText('refused-note.txt');
  await fillComposer(page, 'read this for me');
  await page.getByLabel('Message input').press('Enter');

  await expect(page.getByRole('alert')).toContainText('has no text layer');
  // The message never became a turn, so the draft comes back rather than being
  // destroyed: the file is still uploaded, and retyping it all is not a fix.
  await expect(page.getByLabel('Message input')).toContainText('read this for me');
  await expect(page.getByTestId('attachment-drawer')).toContainText('refused-note.txt');
});

test('a message typed before the conversation opens is not swallowed', async ({page}) => {
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
      json: {state: {activeModelId: model.id, models: [model], chat: []}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
    streamCalls += 1;
    await route.fulfill({
      headers: {'content-type': 'text/event-stream; charset=utf-8'},
      body: '',
    });
  });

  // Hold the conversation list back, so the composer has nowhere to send to.
  let releaseConversations: (() => void) | undefined;
  const conversationsHeld = new Promise<void>(resolve => {
    releaseConversations = resolve;
  });
  await mockConversationRoutes(page, {chat: [], beforeList: () => conversationsHeld});

  await page.goto('/');
  const input = page.getByLabel('Message input');
  await expect(input).toBeVisible();
  // Until the app knows which chat this is, the composer refuses to take a
  // message rather than accepting one and dropping it on the floor.
  await expect(input).toHaveAttribute('contenteditable', 'false');
  expect(streamCalls).toBe(0);

  releaseConversations?.();
  await fillComposer(page, 'now it can go somewhere');
  await input.press('Enter');
  await expect.poll(() => streamCalls).toBe(1);
});

test('deleting the last conversation leaves an empty sidebar', async ({page}) => {
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await expect(page.getByTestId('conversation-row-legacy-default')).toBeVisible();

  await page.getByRole('button', {name: 'Actions for Legacy chat'}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();

  // Conversation routes are mocked here, so this covers the client half only:
  // no conversation to send to means an empty sidebar and a blocked composer.
  // `syncLegacyDefaultConversationFromState` is covered by tests/unit/conversations.test.ts
  // and by the unmocked test below.
  await expect(page.getByTestId('conversation-row-legacy-default')).toHaveCount(0);
  await expect(page.getByText('No chats yet')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Start a chat before sending a message.');
});

test('a deleted conversation is not recreated by the server', async ({page}) => {
  // Deliberately unmocked: this drives the real Fastify server and SQLite so it
  // catches `GET /api/conversations` re-inserting the conversation it lists.
  const rows = page.locator('[data-testid^="conversation-row-"]');

  await page.goto('/');
  await page.getByRole('button', {name: 'New chat'}).click();
  await expect(rows).toHaveCount(1);

  const deleted = page.waitForResponse(
    response =>
      response.request().method() === 'DELETE' && /\/api\/conversations\//.test(response.url()),
  );
  await page.getByRole('button', {name: /^Actions for /}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();

  // The row goes at once; the request waits out the undo window.
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No chats yet')).toBeVisible();
  await deleted;

  // Survives a fresh list request and a server-side startup sync.
  await page.reload();
  await expect(page.getByText('No chats yet')).toBeVisible();
  await expect(rows).toHaveCount(0);
});

test('reloading inside the undo window commits the delete', async ({page}) => {
  // Deferring the request client-side means a reload could silently cancel the
  // deletion, and the conversation would come back from the dead. `pagehide` has
  // to commit it instead.
  const deleteRequests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'DELETE' && request.url().includes('/api/conversations/')) {
      deleteRequests.push(request.url());
    }
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await expect(page.getByTestId('conversation-row-legacy-default')).toBeVisible();

  await page.getByRole('button', {name: 'Actions for Legacy chat'}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();
  await expect(page.getByTestId('conversation-row-legacy-default')).toHaveCount(0);
  expect(deleteRequests, 'the request waits out the undo window').toHaveLength(0);

  // Well inside the 5s window, so only the unload handler can have sent it.
  await page.reload();
  await expect.poll(() => deleteRequests.length).toBe(1);
});

test('deleting a conversation can be undone inside the window', async ({page}) => {
  let deleteRequests = 0;
  await mockConversationRoutes(page, {
    chat: [],
    onDelete: () => {
      deleteRequests += 1;
    },
  });

  await page.goto('/');
  await expect(page.getByTestId('conversation-row-legacy-default')).toBeVisible();

  await page.getByRole('button', {name: 'Actions for Legacy chat'}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();

  await expect(page.getByTestId('conversation-row-legacy-default')).toHaveCount(0);
  const toast = page.getByText(/Deleted "Legacy chat"/);
  await expect(toast).toBeVisible();
  await expect(page.getByText('session file and attachments go with it')).toBeVisible();

  await page.getByRole('button', {name: 'Undo', exact: true}).click();

  await expect(page.getByTestId('conversation-row-legacy-default')).toBeVisible();
  // The row came back because the request never went out, not because the server
  // resurrected it.
  await expect.poll(() => deleteRequests).toBe(0);
});

test('the settings dialog keeps one size across sections and scrolls its content', async ({
  page,
}) => {
  await mockConversationRoutes(page, {chat: []});
  await page.setViewportSize({width: 1500, height: 950});
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await expect(page.getByRole('heading', {name: 'llama.cpp'})).toBeVisible();

  // offsetWidth/Height, not getBoundingClientRect: the dialog animates in from
  // scale(0.95), and a transformed bounding box would report 95% of the layout.
  const dialogSize = () =>
    page.evaluate(() => {
      const dialog = document.querySelector('dialog') as HTMLElement;
      return {width: dialog.offsetWidth, height: dialog.offsetHeight};
    });

  const runtime = await dialogSize();
  expect(runtime).toEqual({width: 1040, height: 760});

  for (const section of ['General', 'Models', 'Reasoning', 'Global Params', 'Tools', 'Chats']) {
    await page.getByRole('button', {name: section, exact: true}).click();
    // Sections must not resize the modal around the user.
    expect(await dialogSize()).toEqual(runtime);
  }

  // Long sections scroll inside the pane rather than growing the modal.
  await page.getByRole('button', {name: 'Runtime', exact: true}).click();
  await page.getByRole('button', {name: 'Show logs'}).click();
  await expect(page.getByText('No llama-server log output yet.')).toBeVisible();
  expect(await dialogSize()).toEqual(runtime);

  // Responsive: it shrinks with the viewport instead of overflowing it.
  await page.setViewportSize({width: 700, height: 560});
  const small = await dialogSize();
  expect(small.width).toBeLessThanOrEqual(700);
  expect(small.height).toBeLessThanOrEqual(560);
  expect(small.width).toBeLessThan(runtime.width);
});

/**
 * A registry the client has never heard of, carrying one of every field type.
 * The General section knows what a `select` is; it must not know what a title is.
 */
const SETTINGS_SCHEMA_FIXTURE = {
  sections: [
    {
      slug: 'demo',
      title: 'Demo group',
      description: 'Served by the server, rendered by nobody in particular.',
      fields: [
        {
          key: 'mode',
          label: 'Mode',
          help: 'One of a fixed set.',
          type: 'select',
          default: 'llm',
          options: [
            {value: 'llm', label: 'Generated by the model'},
            {value: 'off', label: 'Off'},
          ],
        },
        {key: 'label', label: 'Label', help: 'A short string.', type: 'text', default: 'hello'},
        {
          key: 'prompt',
          label: 'Prompt',
          help: 'A long string.',
          type: 'textarea',
          default: 'say something',
          maxLength: 400,
        },
        {
          key: 'maxWords',
          label: 'Max words',
          help: 'A whole number.',
          type: 'number',
          default: 6,
          min: 1,
          max: 20,
          integer: true,
        },
        {key: 'enabled', label: 'Enabled', help: 'A toggle.', type: 'boolean', default: true},
      ],
    },
  ],
};

async function mockSettingsSchema(
  page: Page,
  options: {patch?: (route: Route) => Promise<void>} = {},
): Promise<{patched: Array<Record<string, unknown>>}> {
  const patched: Array<Record<string, unknown>> = [];
  let stored: Record<string, unknown> = {
    mode: 'llm',
    label: 'hello',
    prompt: 'say something',
    maxWords: 6,
    enabled: true,
  };
  await page.route('**/api/settings/schema', async route => {
    await route.fulfill({json: SETTINGS_SCHEMA_FIXTURE});
  });
  await page.route('**/api/settings/demo', async route => {
    if (route.request().method() !== 'PATCH') {
      await route.fulfill({json: stored});
      return;
    }
    patched.push(route.request().postDataJSON() as Record<string, unknown>);
    if (options.patch) {
      await options.patch(route);
      return;
    }
    stored = {...stored, ...(route.request().postDataJSON() as Record<string, unknown>)};
    await route.fulfill({json: stored});
  });
  return {patched};
}

test('the General section renders whatever schema the server serves, and saves it', async ({
  page,
}) => {
  const {patched} = await mockSettingsSchema(page);
  await mockConversationRoutes(page, {chat: []});
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'General', exact: true}).click();

  // Every label, help string, bound and option came off the wire.
  await expect(page.getByRole('heading', {name: 'Demo group'})).toBeVisible();
  await expect(
    page.getByText('Served by the server, rendered by nobody in particular.'),
  ).toBeVisible();
  await expect(page.getByRole('combobox', {name: 'Mode'})).toContainText('Generated by the model');
  await expect(page.getByRole('textbox', {name: 'Label'})).toHaveValue('hello');
  await expect(page.getByRole('textbox', {name: 'Prompt'})).toHaveValue('say something');
  await expect(page.getByRole('spinbutton', {name: 'Max words'})).toHaveValue('6');
  await expect(page.getByRole('switch', {name: 'Enabled'})).toBeChecked();
  await expect(page.getByText('A whole number.')).toBeVisible();

  await page.getByRole('combobox', {name: 'Mode'}).click();
  await page.getByRole('option', {name: 'Off'}).click();
  await page.getByRole('textbox', {name: 'Label'}).fill('renamed');
  await page.getByRole('spinbutton', {name: 'Max words'}).fill('4');
  await page.getByRole('switch', {name: 'Enabled'}).click();
  await page.getByTestId('save-settings-demo').click();

  await expect.poll(() => patched.length).toBe(1);
  expect(patched[0]).toEqual({
    mode: 'off',
    label: 'renamed',
    prompt: 'say something',
    maxWords: 4,
    enabled: false,
  });

  // The values that came back are what the fields show, not what was typed.
  await expect(page.getByRole('combobox', {name: 'Mode'})).toContainText('Off');
  await expect(page.getByRole('switch', {name: 'Enabled'})).not.toBeChecked();
});

test('a settings field the server refuses is named, and the draft survives', async ({page}) => {
  const {patched} = await mockSettingsSchema(page, {
    patch: async route => {
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'invalid_request',
            message: 'Too big: expected number to be <=20',
            detail: 'maxWords',
            retryable: false,
          },
        },
      });
    },
  });
  await mockConversationRoutes(page, {chat: []});
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'General', exact: true}).click();

  await page.getByRole('textbox', {name: 'Label'}).fill('still here');
  await page.getByTestId('save-settings-demo').click();

  // The server's own sentence, not an HTTP status.
  await expect(page.getByText('Too big: expected number to be <=20')).toBeVisible();
  await expect.poll(() => patched.length).toBe(1);
  // A rejected save must not throw away what the user typed.
  await expect(page.getByRole('textbox', {name: 'Label'})).toHaveValue('still here');
});

test('a settings refresh in flight does not overwrite what the user is typing', async ({page}) => {
  const model = {
    id: 'model-a',
    name: 'Model A',
    presetName: 'model-a',
    source: 'huggingface',
    repoId: 'repo/model-a',
    quant: 'UD-Q4_K_M',
    hfRef: 'repo/model-a:UD-Q4_K_M',
    params: {contextSize: 8192, extra: {}},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  let stateCalls = 0;
  let savedModel: {name?: string} | null = null;

  await page.route('**/api/state', async route => {
    stateCalls += 1;
    // The refresh a save triggers lands well after the user starts typing.
    if (stateCalls > 1) {
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
          globalModelParams: {c: '8192'},
        },
        runtime: {...RUNNING_RUNTIME, activeModelId: model.id},
      },
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: {...RUNNING_RUNTIME, activeModelId: model.id}});
  });
  await page.route('**/api/models/global-params', async route => {
    await route.fulfill({json: {globalModelParams: {c: '12288'}}});
  });
  await page.route('**/api/models/model-a', async route => {
    savedModel = route.request().postDataJSON() as {name?: string};
    await route.fulfill({json: {model: {...model, name: savedModel.name ?? model.name}}});
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();

  // Kick off a save, then type into another section while its refresh is still
  // in flight. The refresh used to re-seed every draft and discard this edit.
  await page.getByRole('button', {name: 'Global Params'}).click();
  await page.getByRole('button', {name: 'Save global params'}).click();
  await page.getByRole('button', {name: 'Models'}).click();
  await page.getByLabel('Alias').fill('Edited while refreshing');

  await expect(page.getByText('Global params saved')).toBeVisible();
  await expect(page.getByLabel('Alias')).toHaveValue('Edited while refreshing');

  await page.getByRole('button', {name: 'Save'}).click();
  await expect.poll(() => savedModel?.name).toBe('Edited while refreshing');
});

test('a refused param names the row, offers the key, and fixing it clears the mark', async ({
  page,
}) => {
  const saves: Array<Record<string, string>> = [];
  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: null,
          models: [],
          chat: [],
          // Two rows, so an edit to the good one must not unmark the bad one.
          globalModelParams: {temprature: '0.7', 'top-k': '40'},
        },
        runtime: RUNNING_RUNTIME,
      },
    });
  });
  await page.route('**/api/models/global-params', async route => {
    const params = (route.request().postDataJSON() as {params: Record<string, string>}).params;
    saves.push(params);
    if (params.temprature !== undefined) {
      // What the server sends: a code a client can branch on, and the key that
      // was wrong, so the row can be marked rather than the whole form.
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'invalid_model_param',
            message: '"temprature" is not a llama.cpp option. llama-server would refuse to start.',
            retryable: false,
          },
          invalidParams: [
            {
              key: 'temprature',
              reason: 'unknown',
              message:
                '"temprature" is not a llama.cpp option. llama-server would refuse to start.',
              suggestion: 'temperature',
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({json: {globalModelParams: params}});
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'Global Params'}).click();
  const badKey = page.getByRole('textbox', {name: 'Key'}).first();
  const goodValue = page.getByRole('textbox', {name: 'Value'}).nth(1);
  await expect(badKey).toHaveValue('temprature');

  await page.getByRole('button', {name: 'Save global params'}).click();

  // The row is marked, and the sentence is the server's -- shown beside the row,
  // not only in the app-wide notice, so the user knows which of ten rows is wrong.
  const message = '"temprature" is not a llama.cpp option. llama-server would refuse to start.';
  await expect(badKey).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('dialog').getByText(message)).toBeVisible();

  // Editing an unrelated row must not unmark this one: the key is still wrong.
  await goodValue.fill('50');
  await expect(badKey).toHaveAttribute('aria-invalid', 'true');

  // The suggestion fills the field, which is the only reason to render it.
  await page.getByRole('button', {name: 'Did you mean temperature?'}).click();
  await expect(badKey).toHaveValue('temperature');
  // The mark is joined to the row by its key, so correcting the key clears it.
  await expect(badKey).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', {name: 'Did you mean temperature?'})).toHaveCount(0);

  await page.getByRole('button', {name: 'Save global params'}).click();
  await expect(page.getByText('Global params saved')).toBeVisible();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toEqual({temperature: '0.7', 'top-k': '50'});
});

test('edits reasoning budgets in settings and rejects invalid token counts', async ({page}) => {
  let savedBudgets: unknown = null;
  const budgets = {low: 512, medium: 2048, high: 8192};

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {activeModelId: null, models: [], chat: [], reasoning: {budgets}},
        runtime: RUNNING_RUNTIME,
      },
    });
  });
  await page.route('**/api/settings/reasoning', async route => {
    savedBudgets = (route.request().postDataJSON() as {budgets: unknown}).budgets;
    await route.fulfill({json: {budgets: savedBudgets}});
  });
  await mockConversationRoutes(page, {chat: []});

  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await page.getByRole('button', {name: 'Reasoning', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Reasoning Budgets'})).toBeVisible();

  const low = page.getByLabel('Low', {exact: true});
  await expect(low).toHaveValue('512');
  await expect(page.getByLabel('Medium', {exact: true})).toHaveValue('2048');
  await expect(page.getByLabel('High', {exact: true})).toHaveValue('8192');

  // A budget llama.cpp could not use never reaches the server.
  await low.fill('not-a-number');
  await page.getByRole('button', {name: 'Save reasoning budgets'}).click();
  await expect(page.getByText('Reasoning budgets must be whole numbers')).toBeVisible();
  expect(savedBudgets).toBeNull();

  await low.fill('256');
  await page.getByRole('button', {name: 'Save reasoning budgets'}).click();
  await expect.poll(() => savedBudgets).toEqual({low: 256, medium: 2048, high: 8192});
});

test('no full-viewport backdrop blur repaints behind the settings dialog', async ({page}) => {
  await mockConversationRoutes(page, {chat: []});
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).click();
  await expect(page.getByRole('heading', {name: 'llama.cpp'})).toBeVisible();

  // Astryx's Dialog frosts the whole viewport behind the modal. Every repaint
  // inside the dialog then re-blurs the screen, which collapsed a 4K display to
  // 13fps while hovering the section list. The overlay alone is enough.
  const backdrop = await page.evaluate(() => {
    const dialog = document.querySelector('dialog');
    const style = getComputedStyle(dialog!, '::backdrop');
    return {filter: style.backdropFilter, background: style.backgroundColor};
  });
  expect(backdrop.filter).toBe('none');
  expect(backdrop.background).not.toBe('rgba(0, 0, 0, 0)');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', {name: 'llama.cpp'})).toHaveCount(0);

  // The docked composer paints an opaque backdrop, so ChatLayout's frosted layer
  // would blur a solid colour: pure compositor cost for no visible change.
  const dockFilters = await page.evaluate(() => {
    const dock = document.querySelector('.nelle-chat-layout > *:has(.nelle-chat-composer)');
    return [...(dock?.children ?? [])].map(child => getComputedStyle(child).backdropFilter);
  });
  expect(dockFilters.length).toBeGreaterThan(0);
  expect(dockFilters.every(filter => filter === 'none')).toBe(true);
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

test('only disables the reasoning selector for a template with no thinking mode', async ({
  page,
}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model-one',
    quant: 'UD-Q4_K_XL',
    hfRef: 'repo/model-one:UD-Q4_K_XL',
    params: {contextSize: 16384},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {...RUNNING_RUNTIME, activeModelId: model.id};
  // A new chat, so the server hands back the `max` default.
  const conversations = [
    {
      id: 'fresh-chat',
      title: 'New chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T12:10:00.000Z',
      reasoningLevel: 'max',
    },
  ];
  let propsFail = true;

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
          reasoning: {budgets: {low: 512, medium: 2048, high: 8192}},
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
    if (propsFail) {
      // llama.cpp only answers /props once a model has been loaded at least once.
      await route.fulfill({status: 502, json: {error: {code: 'llama_router_request_failed'}}});
      return;
    }
    await route.fulfill({
      json: {
        modelId: model.id,
        modalities: {vision: false, audio: false, video: false},
        // A plain instruct template: no thinking kwarg, no thinking tags.
        chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}',
        canReason: false,
        raw: {},
      },
    });
  });
  await mockConversationRoutes(page, {chat: [], conversations});

  await page.goto('/');
  await expect(page.getByLabel('Message input')).toBeVisible();

  // Unknown template: the level is still the conversation's, and still editable.
  const selector = page.getByTestId('composer-reasoning-selector');
  await expect(selector).toContainText('Reasoning: max (unlimited)');
  await expect(selector.getByRole('combobox')).toBeEnabled();

  // A template that provably cannot think reads as off, and locks.
  propsFail = false;
  await page.reload();
  await expect(page.getByLabel('Message input')).toBeVisible();
  await expect.poll(() => selector.textContent()).toContain('No reasoning');
  await expect(selector.getByRole('combobox')).toBeDisabled();
});

test('shows thinking blocks and switches reasoning level from the composer', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model-one',
    quant: 'UD-Q4_K_XL',
    hfRef: 'repo/model-one:UD-Q4_K_XL',
    params: {contextSize: 16384},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {...RUNNING_RUNTIME, activeModelId: model.id};
  const chat = [
    {
      id: 'user-1',
      role: 'user',
      content: 'What is 31 times 47?',
      createdAt: '2026-07-07T12:00:00.000Z',
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '31 x 47 = 1457',
      reasoning: 'Break it up: 31 x 40 = 1240, then 31 x 7 = 217.',
      createdAt: '2026-07-07T12:00:01.000Z',
    },
  ];
  const conversations = [
    {
      id: 'thinking-chat',
      title: 'Thinking chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T12:10:00.000Z',
      reasoningLevel: 'medium',
    },
  ];
  const reasoningWrites: Array<[string, string]> = [];

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {
        state: {
          activeModelId: model.id,
          models: [model],
          chat: [],
          reasoning: {budgets: {low: 512, medium: 2048, high: 8192}},
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
        modalities: {vision: false, audio: false, video: false},
        contextWindow: 16384,
        // The kwarg in the template is what unlocks the control, not the name.
        chatTemplate: '{%- if enable_thinking is defined and enable_thinking -%}',
        canReason: true,
        raw: {},
      },
    });
  });
  await mockConversationRoutes(page, {
    chat,
    conversations,
    onReasoningLevel: (conversationId, level) => reasoningWrites.push([conversationId, level]),
  });

  await page.goto('/');
  await expect(page.getByLabel('Message input')).toBeVisible();

  // A completed turn shows its thinking folded away, never inlined in the answer.
  const thinkingTrigger = page.getByRole('button', {name: 'Reasoning', exact: true});
  await expect(thinkingTrigger).toBeVisible();
  await expect(page.getByText('Break it up: 31 x 40 = 1240', {exact: false})).toBeHidden();
  await thinkingTrigger.click();
  await expect(page.getByText('Break it up: 31 x 40 = 1240', {exact: false})).toBeVisible();

  // The level comes from the conversation, and each tier spells out its budget.
  const reasoningSelector = page.getByTestId('composer-reasoning-selector');
  await expect(reasoningSelector).toContainText('Reasoning: medium (2,048 tokens)');
  await reasoningSelector.getByRole('combobox').click();
  await expect(page.getByRole('option', {name: 'Reasoning: high (8,192 tokens)'})).toBeVisible();

  // The composer is a bottom-fixed toolbar, so the dropdown must open above it.
  const maxOption = page.getByRole('option', {name: 'Reasoning: max (unlimited)'});
  const optionBox = await maxOption.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(optionBox).not.toBeNull();
  expect((optionBox?.y ?? 0) + (optionBox?.height ?? 0)).toBeLessThanOrEqual(viewportHeight);

  await maxOption.click();
  await expect.poll(() => reasoningWrites).toEqual([['thinking-chat', 'max']]);
  await expect(reasoningSelector).toContainText('Reasoning: max (unlimited)');
});

test('opens conversations scrolled to the bottom of the transcript', async ({page}) => {
  const model = {
    id: 'model-1',
    name: 'Model One',
    presetName: 'model-one',
    source: 'huggingface',
    repoId: 'repo/model-one',
    quant: 'UD-Q4_K_XL',
    hfRef: 'repo/model-one:UD-Q4_K_XL',
    params: {contextSize: 8192},
    createdAt: '2026-07-07T12:00:00.000Z',
  };
  const runtime = {...RUNNING_RUNTIME, activeModelId: model.id};
  const chat = Array.from({length: 36}, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Scrollable chat message ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 6, 7, 12, index)).toISOString(),
  }));
  const conversations = [
    {
      id: 'first-chat',
      title: 'First chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T12:10:00.000Z',
    },
    {
      id: 'second-chat',
      title: 'Second chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      updatedAt: '2026-07-07T12:05:00.000Z',
    },
  ];

  await page.route('**/api/state', async route => {
    await route.fulfill({
      json: {state: {activeModelId: model.id, models: [model], chat}, runtime},
    });
  });
  await page.route('**/api/runtime', async route => {
    await route.fulfill({json: runtime});
  });
  await mockConversationRoutes(page, {chat, conversations});

  await page.goto('/');
  const chatLayout = page.getByTestId('chat-layout');
  await expect(page.getByLabel('Message input')).toBeVisible();
  await expect(chatLayout.getByText('Scrollable chat message 36')).toBeVisible();

  const distanceFromBottom = async () =>
    chatLayout.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);

  expect(await chatLayout.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect.poll(distanceFromBottom, {timeout: 4000}).toBeLessThanOrEqual(1);

  // Reading back through the transcript releases the pin instead of fighting it.
  await chatLayout.hover();
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(400);
  expect(await distanceFromBottom()).toBeGreaterThan(1);

  // Opening another conversation starts at the bottom again, even though the
  // ChatLayout is never remounted.
  await page
    .getByTestId('conversation-row-second-chat')
    .getByRole('button', {name: 'Second chat', exact: true})
    .click();
  await expect.poll(distanceFromBottom, {timeout: 4000}).toBeLessThanOrEqual(1);
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
  await page.route('**/api/conversations/legacy-default/chat/stream', async route => {
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

  await fillComposer(page, 'stream something');
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
    /** Awaited before the list is served, to hold the app in its loading state. */
    beforeList?: () => Promise<void>;
    importedChat?: MockChatMessage[];
    onCompact?: (instructions?: string) => void;
    onClone?: (conversationId: string, body: {entryId?: string; title?: string}) => void;
    onFork?: (conversationId: string, body: {entryId: string; title?: string}) => void;
    onExport?: (conversationId: string) => void;
    onImport?: () => void;
    abortWarning?: {code: string; message: string};
    onAbort?: () => void;
    onReasoningLevel?: (conversationId: string, level: string) => void;
    onRecover?: (conversationId: string, action: 'repair' | 'rebuild') => void;
    onDelete?: (conversationId: string) => void;
    /** Default true: the session file is still gone, so repair 409s. */
    repairFails?: boolean;
  },
): Promise<void> {
  let chat = input.chat;
  const contextByConversation = new Map<string, ReturnType<typeof contextFromChat>>();
  let conversations = input.conversations ?? [
    {
      id: 'legacy-default',
      title: chat[0]?.content.slice(0, 80) || 'Legacy chat',
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
    if (pathname === '/api/conversations/legacy-default/abort' && request.method() === 'POST') {
      input.onAbort?.();
      await route.fulfill({
        json: {
          ok: true,
          aborted: true,
          warning: input.abortWarning,
          snapshot: conversationSnapshot('legacy-default', chat),
        },
      });
      return;
    }
    const runAbortMatch = pathname.match(
      /^\/api\/conversations\/legacy-default\/runs\/([^/]+)\/abort$/,
    );
    if (runAbortMatch && request.method() === 'POST') {
      input.onAbort?.();
      await route.fulfill({
        json: {
          ok: true,
          aborted: true,
          runId: decodeURIComponent(runAbortMatch[1]!),
          warning: input.abortWarning,
          snapshot: conversationSnapshot('legacy-default', chat),
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
      pathname === '/api/conversations/legacy-default/compact/stream' &&
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
      contextByConversation.set('legacy-default', compactedContext);
      const events = [
        {
          type: 'run.started',
          runId,
          conversationId: 'legacy-default',
          kind: 'compact',
          modelId: 'model-1',
          status: 'running',
          createdAt,
        },
        {
          type: 'compact.started',
          runId,
          conversationId: 'legacy-default',
          instructions: body?.instructions,
          createdAt,
        },
        {
          type: 'context.updated',
          conversationId: 'legacy-default',
          ...compactedContext,
          createdAt,
        },
        {
          type: 'compact.completed',
          runId,
          conversationId: 'legacy-default',
          compacted: true,
          createdAt,
        },
        {
          type: 'run.completed',
          runId,
          conversationId: 'legacy-default',
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
    if (pathname === '/api/conversations/legacy-default/compact' && request.method() === 'POST') {
      const body = request.postDataJSON() as {instructions?: string} | null;
      input.onCompact?.(body?.instructions);
      await route.fulfill({
        json: {
          ok: true,
          compacted: true,
          snapshot: conversationSnapshot('legacy-default', chat),
        },
      });
      return;
    }
    if (
      pathname === '/api/conversations/legacy-default/compact/abort' &&
      request.method() === 'POST'
    ) {
      await route.fulfill({
        json: {
          ok: true,
          aborted: false,
          snapshot: conversationSnapshot('legacy-default', chat),
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
        title: body.title ?? `${source?.title ?? 'Legacy chat'} (copy)`,
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
        title: body.title ?? `${source?.title ?? 'Legacy chat'} (fork)`,
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
    const diagnosticsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/diagnostics$/);
    if (diagnosticsMatch && request.method() === 'GET') {
      const conversationId = decodeURIComponent(diagnosticsMatch[1]!);
      await route.fulfill({
        json: {
          diagnostics: {
            conversationId,
            status: conversations.find(item => item.id === conversationId)?.status ?? 'ready',
            piSessionPath: `/data/pi/sessions/${conversationId}.jsonl`,
            exists: false,
            reason: 'Pi session file is missing.',
            projectionEntryCount: chat.length,
            attachmentCount: 0,
            toolAuditCount: 0,
          },
        },
      });
      return;
    }
    const repairMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/(repair|rebuild)$/);
    if (repairMatch && request.method() === 'POST') {
      const conversationId = decodeURIComponent(repairMatch[1]!);
      const action = repairMatch[2];
      input.onRecover?.(conversationId, action as 'repair' | 'rebuild');
      if (action === 'repair' && input.repairFails !== false) {
        // Repair only succeeds once the file is back, and the mock's file is not.
        await route.fulfill({
          status: 409,
          json: {
            error: {code: 'session_unavailable', message: 'Pi session file is missing.'},
          },
        });
        return;
      }
      conversations = conversations.map(item =>
        item.id === conversationId ? {...item, status: 'ready'} : item,
      );
      const conversation = conversations.find(item => item.id === conversationId);
      await route.fulfill({
        json: {snapshot: conversationSnapshot(conversationId, chat, conversation)},
      });
      return;
    }
    const reasoningMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/reasoning$/);
    if (reasoningMatch && request.method() === 'PUT') {
      const conversationId = decodeURIComponent(reasoningMatch[1]!);
      const body = request.postDataJSON() as {level: string};
      input.onReasoningLevel?.(conversationId, body.level);
      conversations = conversations.map(conversation =>
        conversation.id === conversationId
          ? {...conversation, reasoningLevel: body.level}
          : conversation,
      );
      const conversation = conversations.find(item => item.id === conversationId);
      await route.fulfill({
        json: {
          conversation,
          snapshot: conversationSnapshot(conversationId, chat, conversation),
        },
      });
      return;
    }
    if (pathname === '/api/conversations' && request.method() === 'GET') {
      await input.beforeList?.();
      await route.fulfill({json: paginateConversations(conversations, url)});
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
      input.onDelete?.(conversationId);
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
  const entries = chat.map((message, index) => ({
    conversationId: id,
    piEntryId: message.id,
    parentPiEntryId: index > 0 ? chat[index - 1]?.id : undefined,
    entryType: 'message',
    role: message.role,
    textPreview: message.content,
    createdAt: message.createdAt,
    reasoning: message.reasoning,
    performance: message.performance,
    toolCalls: message.toolCalls,
    modelId: message.modelId,
    modelRuntimeId: message.modelRuntimeId,
    modelAliasSnapshot: message.modelAliasSnapshot,
    regeneratesPiEntryId: message.regeneratesPiEntryId,
    displayGroupId: message.displayGroupId,
  }));

  return {
    conversation: {
      id,
      title: conversation?.title ?? chat[0]?.content.slice(0, 80) ?? 'Legacy chat',
      titleSource: conversation?.titleSource ?? 'fallback',
      pinned: conversation?.pinned ?? false,
      status: conversation?.status ?? 'ready',
      createdAt: '2026-07-07T12:00:00.000Z',
      updatedAt: conversation?.updatedAt ?? '2026-07-07T12:00:00.000Z',
      reasoningLevel: conversation?.reasoningLevel ?? 'off',
    },
    entries,
    // Built with the same function the server uses, so the mock cannot drift
    // from the projection rules the UI depends on.
    messages: buildConversationMessages(
      entries as Parameters<typeof buildConversationMessages>[0],
      attachments as Parameters<typeof buildConversationMessages>[1],
    ),
    activePathEntryIds: chat.map(message => message.id),
    attachments,
    context: context ?? contextFromChat(chat),
    models: {available: []},
    capabilities: {
      canSend: conversation?.status !== 'unavailable',
      canAbort: false,
      canCompact: chat.length > 0,
      canFork: chat.length > 0 && conversation?.status !== 'unavailable',
      canRepair: conversation?.status === 'unavailable',
      canAttachImages: null,
      canReason: null,
    },
    errors:
      conversation?.status === 'unavailable'
        ? [{code: 'session_unavailable', message: 'The conversation session is unavailable.'}]
        : [],
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
      // Mirrors the server: every context payload leaves stamped with a status.
      return withContextStatus({
        usedTokens: promptTokens + (performance?.generation?.tokens ?? 0),
        totalTokens: 8192,
        source: 'timings' as const,
        updatedAt: message.createdAt,
      });
    }
  }
  return {};
}

/**
 * Astryx renders the composer as a contenteditable div and sets
 * `contenteditable="false"` while it is disabled, which it is until `/api/state`
 * names a model and the conversation list resolves. `fill` throws immediately on
 * such a div rather than retrying, so a test that types straight after `goto`
 * races the app's first render.
 *
 * `toBeEditable` does not catch this: Playwright reports a `contenteditable
 * ="false"` div as editable. The attribute is the only honest signal.
 */
async function fillComposer(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('Message input');
  await expect(input).toHaveAttribute('contenteditable', 'true');
  await input.fill(text);
}

type MockChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  attachments?: MockAttachment[];
  reasoning?: string;
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

/** A chat request carries references; the bytes went to `POST /api/uploads`. */
type MockAttachmentRequest = {
  uploadId: string;
};

type MockConversation = {
  id: string;
  title: string;
  titleSource: string;
  pinned: boolean;
  status: string;
  updatedAt: string;
  reasoningLevel?: string;
};

/**
 * Mirrors the server's keyset pagination, so the sidebar is exercised against
 * the contract it will meet in production rather than one giant response.
 *
 * Pinned rows ride along on the first page only; the rest is a keyset walk over
 * `(updatedAt, id)` descending.
 */
function paginateConversations(
  conversations: MockConversation[],
  url: URL,
): {conversations: MockConversation[]; nextCursor?: string; total: number} {
  const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor
    ? (JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as {
        updatedAt: string;
        id: string;
      })
    : null;

  const matches = conversations.filter(
    conversation => !search || conversation.title.toLowerCase().includes(search),
  );
  const byKeyDesc = (a: MockConversation, b: MockConversation) =>
    b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);

  const pinned = cursor ? [] : matches.filter(conversation => conversation.pinned).sort(byKeyDesc);
  const recent = matches
    .filter(conversation => !conversation.pinned)
    .sort(byKeyDesc)
    .filter(
      conversation =>
        !cursor ||
        conversation.updatedAt < cursor.updatedAt ||
        (conversation.updatedAt === cursor.updatedAt && conversation.id < cursor.id),
    )
    .slice(0, limit);

  const last = recent.length === limit ? recent[recent.length - 1] : undefined;
  return {
    conversations: [...pinned, ...recent],
    nextCursor: last
      ? Buffer.from(JSON.stringify({updatedAt: last.updatedAt, id: last.id}), 'utf8').toString(
          'base64url',
        )
      : undefined,
    total: matches.length,
  };
}
