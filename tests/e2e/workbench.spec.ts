import {expect, test} from '@playwright/test';

test('loads the Nelle workbench and searches GGUF models', async ({page}) => {
  await page.route('**/api/huggingface/search**', async route => {
    await route.fulfill({
      json: {
        results: [
          {
            id: 'test/tiny-GGUF',
            author: 'test',
            downloads: 42,
            likes: 7,
            tags: ['gguf', 'conversational'],
            files: [
              {
                filename: 'tiny.Q4_K_M.gguf',
                size: 123_456,
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

  await page.getByLabel('Search query').fill('tiny gguf');
  await page.getByRole('button', {name: 'Search GGUF models'}).click();

  await expect(page.getByText('test/tiny-GGUF')).toBeVisible();
  await expect(page.getByText('tiny.Q4_K_M.gguf')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Download'})).toBeVisible();
});

