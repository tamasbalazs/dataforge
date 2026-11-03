// Keyboard-only use: Tab reaches the whole UI with a visible focus indicator,
// focus never gets lost, dialogs trap and return focus, tabs close with Delete.
// Usage: pnpm build && node e2e/keyboard.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4184;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('   ', typeof extra === 'string' ? extra : JSON.stringify(extra, null, 1));
  }
};

/** Describe the focused element and whether focusing it changes how it (or its container) looks. */
const probe = () =>
  window.eval(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { body: true };
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30);
    const desc = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0] + (label ? ' "' + label + '"' : '');
    const special = !!el.closest('.monaco-editor, .xterm');
    const r = el.getBoundingClientRect();
    const snap = () => [el, el.parentElement, el.parentElement && el.parentElement.parentElement].filter(Boolean).flatMap((n) => {
      const a = getComputedStyle(n), b = getComputedStyle(n, '::after');
      return [a.outlineStyle + a.outlineWidth + a.outlineColor, a.boxShadow, a.backgroundColor, a.borderColor, b.content, b.boxShadow, b.outlineStyle];
    }).join('|');
    const focused = snap();
    el.blur();
    const blurred = snap();
    el.focus();
    return { desc, special, visible: r.width > 0 && r.height > 0, indicator: focused !== blurred };
  })()`);

try {
  await sleep(1500);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByRole('dialog').waitFor();
  check('onboarding starts with focus inside the dialog', await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')));
  for (const ms of [700, 300, 0]) {
    await page.keyboard.press('Enter');
    await sleep(ms);
  }
  await page.locator('.monaco-editor').first().waitFor();
  await sleep(1500);

  // --- Tab sweep -----------------------------------------------------------
  await page.evaluate(() => (document.activeElement)?.blur());
  const seen = new Map();
  const noIndicator = new Set();
  const hidden = new Set();
  let lostFocus = 0;
  let bodyRun = 0;
  let maxBodyRun = 0;
  for (let i = 0; i < 160; i++) {
    await page.keyboard.press('Tab');
    const p = await page.evaluate(probe);
    if (p.body) {
      lostFocus++;
      maxBodyRun = Math.max(maxBodyRun, ++bodyRun);
      continue;
    }
    bodyRun = 0;
    if (p.special) {
      // Monaco keeps Tab for indentation; Ctrl+M switches Tab to moving focus (as in VS Code).
      await page.keyboard.press('Control+m');
      continue;
    }
    seen.set(p.desc, (seen.get(p.desc) ?? 0) + 1);
    if (!p.indicator) noIndicator.add(p.desc);
    if (!p.visible) hidden.add(p.desc);
  }
  const keys = [...seen.keys()].join('\n');
  const areas = { 'title bar': /df-titlebar__search/, 'panel tabs': /dv-tab/, 'editor tabs': /df-editor__tab/, 'panel toolbars': /df-icon-btn/, 'status bar': /df-status__item/ };
  const missing = Object.entries(areas).filter(([, re]) => !re.test(keys)).map(([n]) => n);
  check(`Tab reaches every area (${seen.size} distinct controls, wraps around)`, missing.length === 0 && [...seen.values()].some((n) => n > 1), missing);
  check('every focused control shows a focus indicator', noIndicator.size === 0, [...noIndicator]);
  check('focus never lands on an invisible element', hidden.size === 0, [...hidden]);
  check('focus is never stuck (at most one step on <body> when wrapping)', maxBodyRun <= 1, `longest run on <body>: ${maxBodyRun}`);

  // --- Dialogs ------------------------------------------------------------
  await page.keyboard.press('Alt+2'); // console
  await sleep(300);
  const before = await page.evaluate(() => document.activeElement?.className);
  await page.keyboard.press('Control+Comma');
  await sleep(500);
  const inSettings = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el?.closest('[role="dialog"]') && !el.closest('.df-dialog__header');
  });
  check('settings: focus starts on the first setting, not the close button', inSettings);
  let escaped = false;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))) escaped = true;
  }
  check('settings: Tab stays inside the dialog', !escaped);
  await page.keyboard.press('Escape');
  await sleep(300);
  check('settings: Escape closes and focus returns where it was', (await page.getByRole('dialog').count()) === 0 && (await page.evaluate(() => document.activeElement?.className)) === before);

  for (const [keys, name, first] of [
    ['Control+Alt+l', 'share dialog', 'df-collab-name'],
    ['Control+Alt+k', 'remote hosts dialog', 'df-remote-name'],
  ]) {
    await page.keyboard.press(keys);
    await sleep(600);
    check(`${name}: focus starts on the first field`, (await page.evaluate(() => document.activeElement?.id)) === first, await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  // Palette, fully by keyboard.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('new python');
  await page.keyboard.press('Enter');
  await sleep(600);
  check('palette runs a command from the keyboard', (await page.locator('.df-editor__tab.is-active').innerText()).includes('.py'));

  // Delete closes the focused editor tab; focus stays in the tab list.
  const tabsBefore = await page.locator('.df-editor__tab').count();
  await page.locator('.df-editor__tab.is-active').focus();
  await page.keyboard.press('Delete');
  await sleep(500);
  check('Delete closes the focused editor tab', (await page.locator('.df-editor__tab').count()) === tabsBefore - 1);

  // Delete on a focused panel tab closes the panel; Alt+<n> brings it back.
  await page.locator('.dv-tab', { hasText: 'Help' }).focus();
  await page.keyboard.press('Delete');
  await sleep(400);
  const helpGone = (await page.locator('.dv-tab', { hasText: 'Help' }).count()) === 0;
  await page.keyboard.press('Alt+7');
  await sleep(500);
  check('Delete closes a focused panel tab, its shortcut reopens it', helpGone && (await page.locator('.dv-tab', { hasText: 'Help' }).count()) === 1);
  check('panel tabs are named in the UI language', (await page.locator('.dv-tab[aria-label="Help"]').count()) === 1);

  check('no uncaught page errors', errors.length === 0, errors);
  await browser.close();
} finally {
  server.kill();
}
process.exit(failures ? 1 : 0);
