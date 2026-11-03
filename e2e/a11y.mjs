// Accessibility audit (axe-core, WCAG 2.1 A/AA) of the browser build, in light
// and dark themes: onboarding, workbench, palette, dialogs and every panel.
// Usage: pnpm build && node e2e/a11y.mjs [--report]   (exit 1 on violations)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PORT = 4182;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const found = new Map(); // rule → { impact, help, states:Set, targets:Set }

async function audit(page, state) {
  await sleep(350);
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async () => {
    // Monaco and xterm render their own accessible text areas; their internals are excluded.
    const r = await window.axe.run(
      { exclude: [['.monaco-editor .view-lines'], ['.monaco-editor .margin'], ['.xterm-rows'], ['.xterm-accessibility'], ['iframe']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] },
    );
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => `${n.target.join(' ')}  ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`) }));
  });
  for (const v of res) {
    const f = found.get(v.id) ?? { impact: v.impact, help: v.help, states: new Set(), targets: new Set() };
    f.states.add(state);
    v.nodes.slice(0, 6).forEach((n) => f.targets.add(n));
    found.set(v.id, f);
  }
  console.log(`${res.length ? '✗' : '✓'} ${state}${res.length ? `: ${res.map((v) => `${v.id}(${v.nodes.length})`).join(', ')}` : ''}`);
}

const palette = async (page, text) => {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(text);
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(500);
};

try {
  await sleep(1500);
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: scheme });
    await page.goto(`http://localhost:${PORT}/`);
    await page.getByRole('dialog').waitFor();
    await audit(page, `${scheme}: onboarding`);
    for (const ms of [700, 300, 0]) {
      await page.keyboard.press('Enter');
      await sleep(ms);
    }
    await page.locator('.monaco-editor').first().waitFor();
    await sleep(1200);
    // Some output, a plot and a data frame.
    await page.locator('.df-editor .monaco-editor .view-lines').click({ position: { x: 40, y: 10 } });
    await page.keyboard.press('Control+Shift+Enter');
    await sleep(1500);
    await audit(page, `${scheme}: workbench (analysis layout)`);
    await page.keyboard.press('Control+Alt+O');
    const d = page.getByRole('alertdialog');
    if (await d.waitFor({ timeout: 1500 }).then(() => true, () => false)) {
      await audit(page, `${scheme}: confirm dialog`);
      await d.getByRole('button', { name: "Don't save" }).click();
    }
    await sleep(1200);
    for (const [key, name] of [
      ['Alt+3', 'environment'],
      ['Alt+4', 'plots'],
      ['Alt+5', 'files'],
      ['Alt+6', 'packages'],
      ['Alt+7', 'help'],
      ['Alt+8', 'git'],
      ['Alt+9', 'terminal'],
      ['Alt+0', 'debugger'],
    ]) {
      await page.keyboard.press(key);
      await sleep(700);
      await audit(page, `${scheme}: ${name} panel`);
    }
    for (const [cmd, name] of [
      ['Reproducibility', 'reproducibility panel'],
      ['Extensions', 'extensions panel'],
      ['Collaboration', 'collaboration panel'],
    ]) {
      await palette(page, cmd);
      await audit(page, `${scheme}: ${name}`);
    }
    // Stan: editor with its toolbar, the sampling dialog, the jobs panel running and finished.
    await palette(page, 'New Stan model');
    await page.locator('.df-stan-status', { hasText: 'Compiles' }).waitFor({ timeout: 15000 });
    await audit(page, `${scheme}: Stan editor`);
    await page.getByRole('button', { name: 'Sample as a background job…' }).click();
    await page.getByRole('dialog', { name: /Sample as a background job/ }).waitFor();
    await sleep(300);
    await audit(page, `${scheme}: sampling dialog`);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('.df-jobs__chain').first().waitFor({ timeout: 8000 });
    await audit(page, `${scheme}: jobs panel (running)`);
    await page.locator('.df-toast', { hasText: /Finished: Stan/ }).waitFor({ timeout: 15000 });
    await audit(page, `${scheme}: jobs panel (finished)`);
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('theme');
    await sleep(300);
    await audit(page, `${scheme}: command palette`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Comma');
    await sleep(500);
    await audit(page, `${scheme}: settings dialog`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Alt+k');
    await sleep(600);
    await audit(page, `${scheme}: remote hosts dialog`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Alt+l');
    await sleep(600);
    await audit(page, `${scheme}: share dialog`);
    await page.locator('#df-collab-name').fill('Anna');
    await page.getByRole('button', { name: 'Start sharing' }).click();
    await sleep(800);
    await audit(page, `${scheme}: collaboration panel (hosting)`);
    // Data viewer.
    await page.keyboard.press('Alt+2');
    await page.keyboard.type('View(data)');
    await page.keyboard.press('Enter');
    await sleep(1500);
    await audit(page, `${scheme}: data viewer`);
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}

console.log(`\n${found.size} distinct rule(s) violated`);
for (const [id, f] of found) {
  console.log(`\n[${f.impact}] ${id}: ${f.help}\n  states: ${[...f.states].join('; ')}`);
  for (const t of f.targets) console.log(`  - ${t}`);
}
process.exit(found.size ? 1 : 0);
