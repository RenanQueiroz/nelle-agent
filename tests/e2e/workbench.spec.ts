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
  await expect(page.getByRole('heading', {name: 'llama.cpp'})).toBeVisible();
  await expect(page.getByText('Not installed')).toBeVisible();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
  await expect(page.getByRole('button', {name: 'New chat'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Send'})).toHaveCount(1);
  await expect(page.getByLabel('Max loaded models')).toHaveValue('1');
  await expect(page.getByLabel('Sleep idle seconds')).toHaveValue('90');

  await page.getByRole('button', {name: 'Show logs'}).click();
  await expect(page.getByText('No llama-server log output yet.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Hide logs'})).toBeVisible();

  await page.getByLabel('Search query').fill('qwen gguf');
  await page.getByRole('button', {name: 'Search GGUF models'}).click();

  await expect(page.getByText('unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBeVisible();
  await expect(page.getByText('UD-Q4_K_XL')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Use'}).first()).toBeVisible();

  await page.getByRole('button', {name: 'Use'}).first().click();

  await expect(page.getByText('unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL').first()).toBeVisible();
  await expect(page.getByRole('button', {name: 'Selected'})).toBeVisible();
  await expect(page.getByText('router stopped')).toBeVisible();
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]');
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL');
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

  await expect(page.getByText('loaded', {exact: true})).toBeVisible();
  await expect(page.getByText(`router id: ${model.id}`)).toBeVisible();
  await expect(page.getByRole('button', {name: 'Load', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Unload', exact: true}).click();
  await expect(page.getByText('unloaded', {exact: true})).toBeVisible();
  await expect.poll(() => unloadCalls).toBe(1);

  await page.getByRole('button', {name: 'Load', exact: true}).click();
  await expect.poll(() => loadCalls).toBe(1);
  await expect(page.getByText('loaded', {exact: true})).toBeVisible();

  await page.getByRole('button', {name: 'Reload router models'}).click();
  await expect.poll(() => reloadCalls).toBe(1);
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
  await expect(page.getByText('44 tokens')).toBeVisible();
  await expect(page.getByText('1.36s')).toBeVisible();
  await expect(page.getByText('32.30 t/s')).toBeVisible();

  await page.getByText('32.30 t/s').hover();
  await expect(page.getByText('Prompt processing speed')).toBeVisible();

  await page.getByRole('button', {name: 'Generation (token output)'}).click();
  await expect(page.getByText('6 tokens')).toBeVisible();
  await expect(page.getByText('279ms')).toBeVisible();
  await expect(page.getByText('21.53 t/s')).toBeVisible();

  await page.getByText('21.53 t/s').hover();
  await expect(page.getByText('Generation speed')).toBeVisible();
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
  await expect(page.getByText('Model B').first()).toBeVisible();
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
  await page.getByLabel('Message input').fill('/compact keep file names');
  await page.getByLabel('Message input').press('Enter');

  await expect.poll(() => compactCalls).toBe(1);
  expect(streamCalls).toBe(0);
  await expect(page.getByText('Conversation compacted.')).toBeVisible();
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

async function mockConversationRoutes(
  page: Page,
  input: {chat: MockChatMessage[]; onCompact?: (instructions?: string) => void},
): Promise<void> {
  let chat = input.chat;
  let conversations = [
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
    if (pathname === '/api/conversations' && request.method() === 'GET') {
      await route.fulfill({json: {conversations}});
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
    if (pathname === '/api/conversations/poc-default' && request.method() === 'GET') {
      await route.fulfill({json: {snapshot: conversationSnapshot('poc-default', chat)}});
      return;
    }
    if (pathname === '/api/conversations/new-chat' && request.method() === 'GET') {
      await route.fulfill({json: {snapshot: conversationSnapshot('new-chat', chat)}});
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

function conversationSnapshot(id: string, chat: MockChatMessage[]) {
  return {
    conversation: {
      id,
      title: chat[0]?.content.slice(0, 80) || 'POC chat',
      titleSource: 'fallback',
      pinned: false,
      status: 'ready',
      createdAt: '2026-07-07T12:00:00.000Z',
      updatedAt: '2026-07-07T12:00:00.000Z',
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
    attachments: [],
    context: {},
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

type MockChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  performance?: unknown;
  toolCalls?: unknown;
  modelId?: string;
  modelRuntimeId?: string;
  modelAliasSnapshot?: string;
  regeneratesPiEntryId?: string;
  displayGroupId?: string;
};
