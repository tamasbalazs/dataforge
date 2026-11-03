// Stan support in the browser build: live stanc3 diagnostics (sandboxed
// worker), completion, formatting, data template, {stan} chunks, and a
// sampling job with chain progress (mock host).
// Usage: pnpm build && node e2e/stan.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4185;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('   ', typeof extra === 'string' ? extra : JSON.stringify(extra));
  }
};
const palette = async (page, text) => {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(text);
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(400);
};

try {
  await sleep(1500);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByRole('dialog').waitFor();
  for (const ms of [700, 300, 0]) {
    await page.keyboard.press('Enter');
    await sleep(ms);
  }
  await page.locator('.monaco-editor').first().waitFor();

  // New Stan model: highlighted, and the compiler says it compiles.
  await palette(page, 'New Stan model');
  await page.locator('.df-editor__tab.is-active', { hasText: '.stan' }).waitFor();
  await page.locator('.df-stan-status', { hasText: 'Compiles' }).waitFor({ timeout: 15000 });
  check('stanc3 checks a new model in the sandboxed worker', true);
  check('Stan keywords are highlighted', (await page.locator('.df-editor .view-lines .mtk1, .df-editor .view-lines [class*="mtk"]').count()) > 10);

  // A typo in a distribution name: an error marker with stanc's message.
  const editor = page.locator('.df-editor .monaco-editor .view-lines');
  // Edit inside the model block: line 12 is "  y ~ normal(mu, sigma);".
  const gotoLine = async (n) => {
    await editor.click();
    await page.keyboard.press('Control+g');
    await page.keyboard.type(String(n));
    await page.keyboard.press('Enter');
    await sleep(150);
  };
  await gotoLine(12);
  await page.keyboard.press('End');
  await page.keyboard.type('\n  mu ~ normall(0, 1);');
  await page.locator('.df-stan-status', { hasText: /error/ }).waitFor({ timeout: 10000 });
  const markers = await page.evaluate(() => {
    const m = window.monaco ?? null;
    return m ? null : document.querySelectorAll('.squiggly-error').length;
  });
  check('a typo becomes an error marker in the editor', (markers ?? 0) > 0, markers);
  // F8 (next problem) shows the message, keyboard-accessible.
  await page.keyboard.press('F8');
  await page.locator('.marker-widget', { hasText: 'normall' }).waitFor({ timeout: 5000 }).catch(() => {});
  const msg = await page.locator('.marker-widget').innerText().catch(() => '');
  check('F8 shows stanc\'s explanation of the error', /No function .normall_lpdf. was found/.test(msg), msg.slice(0, 200));
  await page.keyboard.press('Escape');
  await editor.click();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  await page.locator('.df-stan-status', { hasText: 'Compiles' }).waitFor({ timeout: 10000 });

  // Pedantic checks: drop mu's prior (line 10) and the parameter without a prior is reported.
  await gotoLine(10);
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Pedantic checks (warn-pedantic)' }).click();
  await page.locator('.df-stan-status', { hasText: /warning/ }).waitFor({ timeout: 10000 }).catch(() => {});
  const pedantic = await page.locator('.df-stan-status').innerText();
  check('pedantic mode reports a parameter without a prior', /1 warning/.test(pedantic), pedantic);
  await page.getByRole('button', { name: 'Pedantic checks (warn-pedantic)' }).click();
  await editor.click();
  await page.keyboard.press('Control+z');
  await page.locator('.df-stan-status', { hasText: 'Compiles' }).waitFor({ timeout: 10000 });

  // Completion after "~": distributions with parameters.
  await gotoLine(12);
  await page.keyboard.press('End');
  await page.keyboard.type('\n  mu ~ stu');
  await page.keyboard.press('Control+Space');
  await page.locator('.suggest-widget .monaco-list-row', { hasText: 'student_t' }).first().waitFor({ timeout: 5000 });
  check('completion offers distributions after ~', (await page.locator('.suggest-widget .monaco-list-row', { hasText: 'student_t' }).count()) > 0);
  await page.keyboard.press('Enter');
  await sleep(300);
  check('a distribution is inserted with its parameters', (await page.locator('.df-editor .view-lines').innerText()).replace(/ /g, ' ').includes('student_t(nu, mu, sigma)'));
  await page.keyboard.press('Escape');
  await editor.click();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Control+z');
  await page.locator('.df-stan-status', { hasText: 'Compiles' }).waitFor({ timeout: 10000 });

  // Format with stanc.
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('   ');
  await page.getByRole('button', { name: 'Format (stanc)' }).click();
  await sleep(800);
  check('formatting uses stanc (leading spaces removed)', (await page.locator('.df-editor .view-lines .view-line').first().innerText()).replace(/ /g, ' ').startsWith('data {'));

  // R data template from the data block.
  await page.getByRole('button', { name: 'Copy R data list template' }).click();
  await page.locator('.df-toast', { hasText: 'template copied' }).waitFor({ timeout: 5000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('the data template lists N and y with types', /stan_data <- list\(\n\s+N = NA_integer_,\s+# int<lower=0>\n\s+y = numeric\(0\)\s+# vector\[N\]\n\)/.test(clip), clip);

  // Sampling as a background job (mock host): chain progress, divergences, import.
  await page.getByRole('button', { name: 'Sample as a background job…' }).click();
  await page.getByRole('dialog', { name: /Sample as a background job/ }).waitFor({ timeout: 5000 });
  await page.locator('#df-job-chains').fill('4');
  await page.locator('#df-job-adaptDelta').fill('1.5');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  check('invalid options are explained', (await page.locator('.df-job-dialog [role="alert"]', { hasText: 'adapt_delta' }).count()) > 0);
  await page.locator('#df-job-adaptDelta').fill('0.95');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('.df-jobs__chain').first().waitFor({ timeout: 8000 });
  check('the jobs panel shows per-chain progress', (await page.locator('.df-jobs__chain').count()) === 4);
  await page.locator('.df-status__jobs').waitFor({ timeout: 3000 }).catch(() => {});
  check('the status bar shows the running job', (await page.locator('.df-status__jobs').count()) === 1);
  await page.locator('.df-toast', { hasText: /Finished: Stan/ }).waitFor({ timeout: 15000 });
  check('a toast reports the finished job', true);
  check('divergences are flagged with advice', (await page.locator('.df-jobs__warn', { hasText: 'adapt_delta' }).count()) === 1);
  await page.getByRole('button', { name: 'Load as fit' }).click();
  await page.locator('.df-console__input', { hasText: 'fit <- readRDS' }).waitFor({ timeout: 5000 });
  check('results load into the console', true);

  // The panel's start button follows the editor's active tab.
  check('the jobs panel offers sampling for the Stan tab', (await page.getByRole('button', { name: 'Sample from this model…' }).count()) === 1);
  await palette(page, 'New R script');
  await page.locator('.df-editor__tab.is-active', { hasText: '.R' }).waitFor();
  await page.getByRole('button', { name: 'Run R script…' }).waitFor({ timeout: 3000 }).catch(() => {});
  check('…and running a script once an R tab is active', (await page.getByRole('button', { name: 'Run R script…' }).count()) === 1);

  check('no uncaught page errors', errors.length === 0, errors);
  await browser.close();
} finally {
  server.kill();
}
process.exit(failures ? 1 : 0);
