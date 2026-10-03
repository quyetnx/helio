import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

import { expect, test } from '@playwright/test';
import { Client } from 'pg';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const rootEnv = path.resolve(import.meta.dirname, '../../../.env');
  if (existsSync(rootEnv)) loadEnvFile(rootEnv);
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    await client.query('TRUNCATE "email_template" CASCADE');
  } finally {
    await client.end();
  }
});

test('compose a template with live preview and save it', async ({ page }) => {
  await page.goto('/emails');
  await page.getByRole('button', { name: 'New template' }).click();

  await page.getByLabel('Name').fill('Welcome email');
  await page.getByLabel('Subject').fill('Welcome, {{firstName|friend}}!');

  const heading = page.getByTestId('block-heading');
  await heading.getByLabel('Text').fill('Hello {{firstName|there}}');
  const paragraph = page.getByTestId('block-paragraph');
  await paragraph.getByLabel('Text').fill('Thanks for joining us.');
  const button = page.getByTestId('block-button');
  await button.getByLabel('Button label').fill('Get started');
  await button.getByLabel('Link URL').fill('https://example.com/start');

  // Server-rendered preview personalizes with the sample contact (Ada).
  const preview = page.getByTestId('template-preview');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="template-preview"]');
  await expect(frame.getByText('Hello Ada')).toBeVisible({ timeout: 15_000 });
  await expect(frame.getByRole('link', { name: 'Get started' })).toBeVisible();
  await expect(page.getByTestId('preview-subject')).toContainText('Welcome, Ada!');

  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(page.getByText('Template created')).toBeVisible();
  await expect(page.getByTestId('template-card')).toContainText('Welcome email');
});

test('reorder and edit blocks, then save changes', async ({ page }) => {
  await page.goto('/emails');
  await page.getByRole('button', { name: 'Welcome email', exact: true }).click();
  await expect(page.getByTestId('template-editor-card')).toBeVisible();

  // Move the button block above the paragraph.
  const button = page.getByTestId('block-button');
  await button.getByLabel('Move up').click();
  const blockTypes = await page
    .getByTestId('block-list')
    .locator('[data-testid^="block-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
  expect(blockTypes).toEqual(['block-heading', 'block-button', 'block-paragraph']);

  await page.getByLabel('Subject').fill('Updated subject');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Template updated')).toBeVisible();
  await expect(page.getByTestId('template-card')).toContainText('Updated subject');
});

test('delete the template', async ({ page }) => {
  await page.goto('/emails');
  await page.getByRole('button', { name: 'Delete Welcome email' }).click();
  await expect(page.getByText('Template deleted')).toBeVisible();
  await expect(page.getByTestId('template-card')).toHaveCount(0);
});

test('rebuild a template from an image with the AI copilot', async ({ page }) => {
  // The AI plane is not part of the e2e stack: answer the tRPC mutation with a
  // canned draft, and assert on what the UI sends and how it fills the editor.
  let sent: { json?: { imageBase64?: string; mediaType?: string; prompt?: string } } | undefined;
  await page.route('**/api/trpc/copilot.draftEmailFromImage*', async (route) => {
    const body = route.request().postDataJSON() as Record<string, typeof sent>;
    sent = body['0'];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          result: {
            data: {
              json: {
                name: 'Summer Sale',
                subject: 'Summer sale — 30% off',
                document: {
                  blocks: [
                    { id: 'b1', type: 'heading', text: 'Summer sale' },
                    { id: 'b2', type: 'paragraph', text: 'Take 30% off everything.' },
                    { id: 'b3', type: 'button', label: 'Shop now', url: 'https://example.com' },
                  ],
                },
              },
            },
          },
        },
      ]),
    });
  });

  await page.goto('/emails');
  await page.getByRole('button', { name: 'New template' }).click();
  await expect(page.getByTestId('image-to-template')).toBeVisible();

  // 1×1 transparent PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page
    .getByTestId('image-to-template-input')
    .setInputFiles({ name: 'mockup.png', mimeType: 'image/png', buffer: png });
  await page.getByLabel('Extra guidance (optional)').fill('keep it short');
  await page.getByRole('button', { name: 'Build template with AI' }).click();

  await expect(page.getByText('Draft ready — review it, then save.')).toBeVisible();
  expect(sent?.json?.mediaType).toBe('image/png');
  expect(sent?.json?.prompt).toBe('keep it short');
  expect(Buffer.from(sent?.json?.imageBase64 ?? '', 'base64').equals(png)).toBe(true);

  // The editor is filled in and nothing was saved yet.
  await expect(page.getByLabel('Name')).toHaveValue('Summer Sale');
  await expect(page.getByLabel('Subject')).toHaveValue('Summer sale — 30% off');
  await expect(page.getByTestId('block-heading').getByLabel('Text')).toHaveValue('Summer sale');
  await expect(page.getByTestId('block-button').getByLabel('Button label')).toHaveValue('Shop now');
});

test('rejects a non-image file before calling the AI', async ({ page }) => {
  let called = false;
  await page.route('**/api/trpc/copilot.draftEmailFromImage*', (route) => {
    called = true;
    return route.abort();
  });
  await page.goto('/emails');
  await page.getByRole('button', { name: 'New template' }).click();
  await page
    .getByTestId('image-to-template-input')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.getByText('Use a PNG, JPEG, WebP or GIF image.')).toBeVisible();
  expect(called).toBe(false);
});
