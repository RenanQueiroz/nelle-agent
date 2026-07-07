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
