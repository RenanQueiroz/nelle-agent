import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test} from '@playwright/test';

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

  await page.goto('/');

  await expect(page.getByRole('heading', {name: 'Nelle Agent'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'llama.cpp'})).toBeVisible();
  await expect(page.getByText('Not installed')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Reset conversation'})).toBeDisabled();

  await page.getByLabel('Search query').fill('qwen gguf');
  await page.getByRole('button', {name: 'Search GGUF models'}).click();

  await expect(page.getByText('unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBeVisible();
  await expect(page.getByText('UD-Q4_K_XL')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Use'}).first()).toBeVisible();

  await page.getByRole('button', {name: 'Use'}).first().click();

  await expect(
    page.getByRole('button', {
      name: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]');
  await expect
    .poll(() => fs.readFile(path.join(repoRoot, '.nelle-e2e', 'llama', 'models.ini'), 'utf8'))
    .toContain('hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL');
});

test('renders llama.cpp throughput in chat message metadata', async ({page}) => {
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
  await page.route('**/api/chat/stream', async route => {
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
      performance: {
        tokensPerSecond: 21.529452290733722,
        source: 'llamacpp-timings',
        generatedTokens: 6,
      },
    };
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
  await expect(page.getByText('21.5 tok/s')).toBeVisible();
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
  await page.route('**/api/chat/stream', async route => {
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
      toolCalls: [completedCall],
    };
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
