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

test('expands TODOs by note and opens the highlighted occurrence', async ({ page }) => {
  await page.locator('[data-testid="rail-todos"]').click();

  const group = page.locator('[data-testid="todo-group"]', { hasText: 'Ideas' });
  await expect(group).toBeVisible();
  const expand = group.locator('button[aria-expanded]');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();

  const matches = group.locator('[data-testid="todo-match"]');
  await expect(matches).toHaveCount(2);
  await expect(matches.first().locator('mark.search-highlight')).toHaveText('TODO:');
  await matches.first().click();

  await expect(page.locator('#note-editor')).toHaveValue(/TODO: Add another idea/);
  await expect(page).toHaveURL(/\/Ideas\?search=TODO%3A&line=5&col=1$/);
  await expect(page.locator('[data-testid="preview"] mark.search-highlight')).toHaveText('TODO:');
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

test('deletes multiple selected notes and folders with one confirmation', async ({ page }) => {
  await page.locator('[data-testid="tree-selection-toggle"]').click();

  await page.locator('.note-item[data-path="Welcome.md"] .tree-select-checkbox').check();
  await page.locator('.folder-item[data-path="Projects"] .tree-select-checkbox').check();
  await expect(page.locator('[data-testid="tree-selection-toolbar"]')).toContainText('2 marcados');

  await page.locator('[data-testid="delete-selected-items"]').click();
  const confirmDialog = page.locator('[role="alertdialog"]');
  await expect(confirmDialog).toContainText('Excluir permanentemente 2 itens selecionados');
  await confirmDialog.locator('button').last().click();

  await expect(page.locator('.note-item[data-path="Welcome.md"]')).toHaveCount(0);
  await expect(page.locator('.folder-item[data-path="Projects"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="tree-selection-toolbar"]')).toBeHidden();

  const response = await page.request.get('/api/notes');
  const data = await response.json();
  expect(data.notes.some(note => note.path.startsWith('Projects/'))).toBe(false);
  expect(data.folders.some(folder => folder.startsWith('Projects'))).toBe(false);
});

test('selects the visible range with Shift', async ({ page }) => {
  await page.locator('[data-testid="tree-selection-toggle"]').click();
  const checkboxes = page.locator('.tree-row:visible .tree-select-checkbox');
  const count = await checkboxes.count();
  expect(count).toBeGreaterThan(1);

  await checkboxes.nth(0).click();
  await checkboxes.nth(count - 1).click({ modifiers: ['Shift'] });

  for (let index = 0; index < count; index += 1) {
    await expect(checkboxes.nth(index)).toBeChecked();
  }
});
