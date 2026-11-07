// Smoke tests for the real Go server + bundled frontend.
//
// These are intentionally end-to-end (no mocked API): they boot the binary
// against a throwaway vault and exercise the flows a rewrite or a big template
// refactor is most likely to break: boot, open, search, wikilinks, theme,
// create, autosave, upload and attach.
import { expect, test } from '@playwright/test';

// Smallest valid 1x1 PNG, reused by the upload/attach tests.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=',
  'base64',
);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="rail-files"]')).toBeVisible();
});

test('boots on the homepage and lists the vault', async ({ page }) => {
  await expect(page).toHaveTitle(/Basalt E2E/);
  await expect(page.locator('[data-testid="homepage-note"][data-path="Welcome.md"]')).toBeVisible();
  await expect(page.locator('[data-testid="homepage-note"][data-path="Ideas.md"]')).toBeVisible();
  await expect(page.locator('.folder-item[data-path="Projects"]')).toBeVisible();
});

test('opens a note from the sidebar and renders the preview', async ({ page }) => {
  await page.locator('.note-item[data-path="Welcome.md"]').click();

  await expect(page.locator('#note-editor')).toHaveValue(/This is the end-to-end test vault/);
  await expect(page.locator('[data-testid="preview"] h1')).toHaveText('Welcome');
  await expect(page).toHaveURL(/\/Welcome$/);
});

test('searches the vault and opens a match', async ({ page }) => {
  await page.locator('[data-testid="rail-search"]').click();
  await page.locator('[data-testid="search-input"]').fill('Ship');

  const group = page.locator('.search-result-group', { hasText: 'Roadmap' });
  await expect(group.locator('.search-result-header')).toBeVisible();
  await group.locator('.search-result-header').click();
  await group.locator('.search-match-row').first().click();

  await expect(page.locator('#note-editor')).toHaveValue(/Ship the smoke tests/);
  await expect(page).toHaveURL(/\/Projects\/Roadmap(\?.*)?$/);
});

test('follows a wikilink from the preview', async ({ page }) => {
  await page.locator('.note-item[data-path="Welcome.md"]').click();

  const link = page.locator('[data-testid="preview"] a.wikilink', { hasText: 'Roadmap' });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page.locator('#note-editor')).toHaveValue(/Ship the smoke tests/);
  await expect(page).toHaveURL(/\/Projects\/Roadmap(\?.*)?$/);
});

test('persists the theme choice across a reload', async ({ page }) => {
  await page.locator('[data-testid="rail-settings"]').click();
  await page.locator('[data-testid="theme-select"]').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('creates a new note from the files panel', async ({ page }) => {
  await page.locator('[data-testid="new-button"]').click();
  await page.locator('[data-testid="new-note"]').click();

  await expect(page.locator('#create-name-modal-input')).toBeVisible();
  await page.locator('#create-name-modal-input').fill('E2E Note');
  await page.locator('[data-testid="create-submit"]').click();

  await expect(page.locator('.note-item[data-path="E2E Note.md"]')).toBeVisible();
  await expect(page.locator('#note-editor')).toHaveValue('');
});

test('edits a note and waits for autosave, then reloads it', async ({ page }) => {
  await page.locator('.note-item[data-path="EditMe.md"]').click();
  const editor = page.locator('#note-editor');
  await expect(editor).toHaveValue(/Replace this content/);

  await editor.fill('# Edit me\n\nSaved by the e2e suite.');
  await expect(page.locator('[data-testid="saved"]')).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.locator('#note-editor')).toHaveValue(/Saved by the e2e suite/);
});

test('uploads a media file through the global picker', async ({ page }) => {
  // Click the panel button, not the input: this exercises
  // $refs.globalFileInput from inside the files panel's Alpine scope.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="upload-button"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'e2e-pixel.png',
    mimeType: 'image/png',
    buffer: PIXEL_PNG,
  });

  // Media lands in the current folder's _attachments directory. Expand it to
  // prove the uploaded file made it into the tree.
  const attachments = page.locator('.folder-item[data-path="_attachments"]');
  await expect(attachments).toBeVisible({ timeout: 10_000 });
  await attachments.click();
  await expect(page.locator('.note-item[data-path*="e2e-pixel"]')).toBeVisible();
});

test('attaches a media file from the editor toolbar', async ({ page }) => {
  await page.locator('.note-item[data-path="Welcome.md"]').click();
  await expect(page.locator('#note-editor')).toHaveValue(/This is the end-to-end/);

  // The attach input lives in the editor panel, so this exercises
  // $refs.attachFileInput through the editor's own Alpine scope.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="attach-button"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'e2e-attach.png',
    mimeType: 'image/png',
    buffer: PIXEL_PNG,
  });

  await expect(page.locator('#note-editor')).toHaveValue(/e2e-attach/, { timeout: 10_000 });
});

test('renders a markmap note beside its editable Markdown source', async ({ page }) => {
  await page.locator('.note-item[data-path="Welcome.md"]').click();

  const editor = page.locator('#note-editor');
  const source = '---\nnote-type: markmap\n---\n# Project\n\n## Plan\n\n- Implement\n- Test\n- <img src=x onerror=alert(1)>';
  await editor.fill(source);

  await expect(editor).toHaveValue(source);
  const map = page.locator('.markmap-container .markmap-svg');
  await expect(map.locator('.markmap-node').filter({ hasText: 'Project' })).toHaveCount(1);
  await expect(map.locator('.markmap-node').filter({ hasText: 'Implement' })).toHaveCount(1);
  await expect(map).not.toHaveCSS('--markmap-max-width', '400px');
  await expect(map.locator('img, script')).toHaveCount(0);
  await expect(page.locator('[data-testid="preview"] h1')).toHaveCount(0);

  const mapColor = await map.evaluate((svg) => getComputedStyle(svg).color);
  const previewColor = await page.locator('[data-testid="preview"]').evaluate((preview) => getComputedStyle(preview).color);
  expect(mapColor).toBe(previewColor);

  const customSource = source.replace('note-type: markmap', 'note-type: markmap\nmarkmap:\n  maxWidth: 250');
  await editor.fill(customSource);
  await expect(map).toHaveCSS('--markmap-max-width', '250px');

  await page.locator('[data-testid="rail-settings"]').click();
  await page.locator('[data-testid="theme-select"]').selectOption('dark');
  await page.locator('[data-testid="rail-files"]').click();
  await page.locator('.note-item[data-path="Welcome.md"]').click();
  await editor.fill(source);
  await expect(map).not.toHaveCSS('--markmap-max-width', '400px');
  const darkMapColor = await map.evaluate((svg) => getComputedStyle(svg).color);
  const darkPreviewColor = await page.locator('[data-testid="preview"]').evaluate((preview) => getComputedStyle(preview).color);
  expect(darkMapColor).toBe(darkPreviewColor);
});
