// End-to-end smoke test against the browser build (mock host).
// Usage: pnpm build && pnpm e2e   (needs `npx playwright install chromium` once)
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4180;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures++;
};

try {
  await sleep(1500);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);

  // Onboarding: keyboard only.
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Enter');
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(300);
  check('primary action keeps focus across onboarding steps', (await page.evaluate(() => document.activeElement?.textContent)) === 'R example');
  await page.keyboard.press('Enter');
  await page.locator('.monaco-editor').first().waitFor();
  await sleep(1500);

  // Ctrl+Enter in the editor runs the statement under the cursor (regression:
  // console keybindings used to hijack the editor's).
  await page.locator('.df-editor .monaco-editor .view-lines').click({ position: { x: 40, y: 70 } });
  await page.keyboard.press('Control+Enter');
  await page.locator('.df-console__input').first().waitFor({ timeout: 5000 });
  check('Ctrl+Enter runs code from the editor', (await page.locator('.df-console__input').count()) === 1);
  await sleep(800);
  check('environment panel shows the new variable', (await page.locator('.df-env__name', { hasText: 'data' }).count()) === 1);

  // Console input: Enter submits.
  await page.locator('[data-console-input] .view-lines').click();
  await page.keyboard.type('plot(1:10)');
  await page.keyboard.press('Enter');
  await page.locator('.df-plots__img').waitFor({ timeout: 5000 });
  check('console Enter runs code and the plot panel shows the plot', true);
  await page.getByRole('button', { name: 'Export' }).click();
  check('export menu offers the available formats', (await page.getByRole('menuitem').count()) >= 1);
  await page.keyboard.press('Escape');

  // Data viewer: View() opens a tab; sorting, filtering and keyboard work.
  await page.locator('[data-console-input] .view-lines').click();
  await page.keyboard.type('View(data)');
  await page.keyboard.press('Enter');
  await page.locator('.df-grid__row').first().waitFor({ timeout: 5000 });
  check('View() opens the data viewer', (await page.locator('.df-data__title').innerText()) === 'data');
  await page.locator('.df-grid__head-main', { hasText: 'id' }).click();
  await page.locator('.df-grid__head-main', { hasText: 'id' }).click();
  await sleep(600);
  check('sorting descending puts the last row first', (await page.locator('.df-grid__row').first().locator('.df-grid__rownum').innerText()).replace(/\D/g, '') === '100000');
  const groupHead = page.locator('.df-grid__head', { hasText: 'group' });
  await groupHead.hover();
  await groupHead.locator('.df-grid__menu-btn').click();
  await page.keyboard.type('= beta');
  await page.keyboard.press('Enter');
  await sleep(800);
  check('column filter narrows the rows', /25[\s,.\u00a0\u202f]?000/.test(await page.locator('.df-data__dims strong').innerText()));
  check('header shows distributions', (await page.locator('.df-grid__hist rect').count()) > 10);
  await page.locator('.df-grid').focus();
  await page.keyboard.press('ArrowDown');
  check('keyboard selects cells', (await page.locator('.df-grid__cell.is-selected').count()) === 1);

  // New file from a shortcut gets the keyboard (regression: focus landed on
  // another document's tab and Enter switched documents).
  await page.keyboard.press('Control+Alt+Shift+N');
  await sleep(600);
  await page.keyboard.type('x = 1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('y = 2');
  await sleep(200);
  const activeTab = await page.locator('.df-editor__tab.is-active .df-editor__tab-name').innerText();
  const text = await page.locator('.df-editor .view-lines').innerText();
  const ok = /\.py$/.test(activeTab) && /x = 1\s+y = 2/.test(text.replace(/\u00a0/g, ' '));
  check('new file keeps focus and receives typing', ok);
  if (!ok) console.log('   active tab:', activeTab, '| text:', JSON.stringify(text));

  // Projects, files, packages, help.
  await page.keyboard.press('Control+Alt+O');
  await page.getByRole('alertdialog').waitFor({ timeout: 3000 });
  check('switching projects asks about unsaved files', true);
  await page.getByRole('button', { name: "Don't save" }).click();
  await sleep(1500);
  check('opening a project shows its name in the title bar', (await page.locator('.df-titlebar__project').innerText()).includes('projekt'));
  await page.keyboard.press('Alt+5');
  await page.locator('.df-files__row', { hasText: 'analysis.R' }).waitFor({ timeout: 3000 });
  check('files panel lists the project', (await page.locator('.df-files__row').count()) >= 5);
  await page.locator('.df-files__row', { hasText: 'analysis.R' }).dblclick();
  await sleep(800);
  check('double-click opens a script in the editor', (await page.locator('.df-editor__tab.is-active').innerText()).includes('analysis.R'));
  await page.keyboard.press('Alt+6');
  await page.locator('.df-pkg').first().waitFor({ timeout: 3000 });
  check('packages panel lists installed packages', (await page.locator('.df-pkg').count()) >= 4);
  await page.locator('[data-console-input] .view-lines').click();
  await page.keyboard.type('?mean');
  await page.keyboard.press('Enter');
  await page.locator('.df-help__frame').waitFor({ timeout: 3000 });
  const helpText = await page.frameLocator('.df-help__frame').locator('h2').innerText();
  check('?topic in the console opens help', helpText.includes('Arithmetic Mean'));
  check('help keeps focus in the console', await page.evaluate(() => !!document.activeElement?.closest('[data-console-input]')));
  await page.frameLocator('.df-help__frame').getByText('weighted.mean').click();
  await sleep(500);
  check('help links navigate inside the panel', await page.locator('.df-help .df-icon-btn[aria-label]').first().isEnabled());

  // Quarto: chunks run in their own language, Ctrl+Shift+K renders a preview.
  await page.keyboard.press('Alt+5');
  await page.locator('.df-files__row', { hasText: 'report.qmd' }).dblclick();
  await page.locator('.view-line', { hasText: 'summary(sales)' }).waitFor({ timeout: 3000 });
  await page.locator('.codelens-decoration', { hasText: 'Python' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('chunks get a Run lens', (await page.locator('.codelens-decoration', { hasText: 'Python' }).count()) === 1);
  await page.locator('.view-line', { hasText: 'summary(sales)' }).click();
  await page.keyboard.press('Control+Shift+Enter');
  await sleep(500);
  const lastInput = async () => (await page.locator('.df-console__input').last().innerText()).replace(/\u00a0/g, ' ');
  check('Ctrl+Shift+Enter runs the R chunk in R', (await lastInput()).includes('sales <- read.csv') && (await lastInput()).includes('summary(sales)'));
  await page.locator('.view-line', { hasText: 'print(len(df))' }).click();
  await page.keyboard.press('Control+Enter');
  await sleep(500);
  check('Ctrl+Enter in a Python chunk runs the line in Python', (await page.locator('.df-console').getAttribute('data-lang')) === 'python' || (await lastInput()).includes('print(len(df))'));
  await page.keyboard.press('Control+Shift+K');
  await page.locator('.df-preview__frame').waitFor({ timeout: 5000 });
  const previewTitle = await page.frameLocator('.df-preview__frame').locator('h1').innerText();
  check('Ctrl+Shift+K renders the document into the preview panel', previewTitle === 'report');
  check('preview reports the render time', /\d/.test(await page.locator('.df-preview__status').innerText()));
  // Regression: a second document must show its own page, not the first one's.
  await page.keyboard.press('Alt+5');
  await page.locator('.df-files__row', { hasText: 'README.md' }).dblclick();
  await sleep(600);
  await page.keyboard.press('Control+Shift+K');
  await page.frameLocator('.df-preview__frame').locator('h1', { hasText: 'README' }).waitFor({ timeout: 5000 }).catch(() => {});
  check('previewing another document shows that document', (await page.frameLocator('.df-preview__frame').locator('h1').innerText()) === 'README');

  // Bridge: the environment panel copies a variable into the other language.
  await page.keyboard.press('Alt+3');
  await page.locator('[data-panel="environment"]').getByRole('radio', { name: 'R', exact: true }).click();
  await sleep(300);
  const row = page.locator('.df-env__row', { hasText: 'data' }).first();
  if (await row.count()) {
    await row.hover();
    await row.locator('.df-env__act--bridge').click();
    await sleep(500);
    check('copy to the other language runs a visible bridge line', (await lastInput()).includes('data = r.data'));
  } else check('copy to the other language runs a visible bridge line', false);

  // Git: changes, diff, stage, commit, history.
  await page.keyboard.press('Control+Shift+G');
  await page.locator('.df-git__file', { hasText: 'analysis.R' }).waitFor({ timeout: 4000 });
  check('Git panel lists the working-tree changes', (await page.locator('.df-git__row').count()) === 2);
  await page.locator('.df-git__file', { hasText: 'analysis.R' }).click();
  await page.locator('.df-diff__stats').waitFor({ timeout: 5000 });
  check('clicking a change opens a diff with line stats', (await page.locator('.df-diff__stats').innerText()).includes('+1'));
  const gitRow = page.locator('.df-git__row', { hasText: 'analysis.R' });
  await gitRow.hover();
  await gitRow.getByRole('button', { name: 'Stage', exact: true }).click();
  await page.locator('.df-git__section', { hasText: 'Staged' }).waitFor({ timeout: 3000 });
  check('staging moves the file to Staged', (await page.locator('.df-git__section', { hasText: 'Staged' }).locator('.df-git__row').count()) === 1);
  await page.locator('.df-git__commit textarea').fill('Elemzés bővítése');
  await page.locator('.df-git__commit textarea').press('Control+Enter');
  await page.locator('.df-git__row', { hasText: 'analysis.R' }).waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  check('Ctrl+Enter commits the staged change', (await page.locator('.df-git__row').count()) === 1);
  check('status bar shows the branch with a commit to push', /main/.test(await page.locator('.df-status').innerText()) && (await page.locator('.df-status').innerText()).includes('1'));
  await page.locator('.df-git').getByRole('radio', { name: /History/ }).click();
  await page.locator('.df-git__subject', { hasText: 'Elemzés bővítése' }).waitFor({ timeout: 3000 }).catch(() => {});
  check('history shows the new commit first', (await page.locator('.df-git__subject').first().innerText()).includes('Elemzés bővítése'));

  // Terminal: Ctrl+` opens a shell in the project folder.
  await page.keyboard.press('Control+`');
  await page.locator('.df-term .xterm').waitFor({ timeout: 4000 });
  await sleep(300);
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await sleep(300);
  check('terminal runs commands in the project folder', (await page.locator('.df-term .xterm-rows').innerText()).includes('/home/demo/projekt'));
  await page.keyboard.press('Control+w');
  await sleep(200);
  check('Ctrl+W in the terminal goes to the shell, not the app', (await page.locator('.df-term').count()) === 1);

  // Merge conflicts: CodeLens resolves a block.
  await page.keyboard.press('Control+Alt+n');
  await page.locator('.monaco-editor textarea').first().waitFor();
  await sleep(400);
  await page.keyboard.type('<<<<<<< HEAD\nx <- 1\n=======\nx <- 2\n>>>>>>> feature\n');
  await page.locator('.codelens-decoration', { hasText: 'Accept incoming' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('conflict blocks get Accept lenses', (await page.locator('.codelens-decoration', { hasText: 'Accept incoming' }).count()) === 1);
  await page.locator('.codelens-decoration a', { hasText: 'Accept incoming' }).click();
  await sleep(300);
  const resolved = (await page.locator('.df-editor .view-lines').first().innerText()).replace(/\u00a0/g, ' ');
  check('accepting incoming keeps only that side', resolved.includes('x <- 2') && !resolved.includes('<<<<<<<') && !resolved.includes('x <- 1'));

  // Debugger (R, mock adapter): F9 breakpoint, F5 run, inspect, evaluate, continue.
  await page.keyboard.press('Alt+5');
  await page.locator('.df-files__row', { hasText: 'analysis.R' }).dblclick();
  await page.locator('.view-line', { hasText: 'summary(cars)' }).click();
  await page.keyboard.press('F9');
  await sleep(200);
  check('F9 sets a breakpoint in the gutter', (await page.locator('.monaco-editor .df-bp').count()) === 1);
  await page.keyboard.press('F5');
  await page.locator('.df-debug-line').waitFor({ timeout: 4000 }).catch(() => {});
  check('F5 runs the file and pauses on the breakpoint line', (await page.locator('.df-debug-line').count()) === 1 && (await page.locator('.df-status__debug').innerText()).includes('2'));
  await page.locator('.df-dbg__var', { hasText: 'adat' }).waitFor({ timeout: 3000 }).catch(() => {});
  await page.locator('.df-dbg__var', { hasText: 'adat' }).click();
  await sleep(300);
  check('debugger shows the frame variables, expandable', (await page.locator('.df-dbg__var').count()) >= 5);
  await page.locator('.df-dbg__eval').fill('total * 2');
  await page.locator('.df-dbg__eval').press('Enter');
  await sleep(300);
  check('evaluating in the paused frame shows the result', (await page.locator('.df-dbg__logentry pre').last().innerText()).includes('12'));
  await page.keyboard.press('F5');
  await page.locator('.df-debug-line').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  await page.locator('.df-status__debug').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  check('F5 again continues to the end', (await page.locator('.df-debug-line').count()) === 0 && (await page.locator('.df-status__debug').count()) === 0);

  // Reproducibility: report, then export a bundle.
  await page.keyboard.press('Control+Alt+e');
  await page.locator('.df-repro__headline').waitFor({ timeout: 6000 });
  const checks = await page.locator('.df-repro__check').allInnerTexts();
  check('reproducibility report pins R packages and reads git', checks.some((c) => /R 4\.4\.1/.test(c) && /packages pinned/.test(c)) && checks.some((c) => /Commit [0-9a-f]{7}/.test(c)));
  check('report lists data files with checksums', checks.some((c) => /data files/.test(c)) && checks.some((c) => /SHA-256/.test(c)));
  await page.getByRole('button', { name: 'Export bundle…' }).click();
  await page.locator('.df-toast', { hasText: 'Exported' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('export writes the bundle', (await page.locator('.df-toast', { hasText: 'Exported' }).count()) === 1);

  // Extensions: consent, command, panel with two-way messages, contributed theme.
  await page.keyboard.press('Control+Shift+x');
  const review = page.getByRole('button', { name: 'Review', exact: true });
  await review.waitFor({ timeout: 5000 });
  await review.click();
  await page.getByRole('alertdialog').waitFor({ timeout: 3000 });
  check('installing asks for the permissions', /Read the selection/.test(await page.getByRole('alertdialog').innerText()));
  await page.getByRole('button', { name: /Allow and enable/ }).click();
  await page.locator('.df-ext.is-active').waitFor({ timeout: 5000 });
  check('approved extension activates', (await page.locator('.df-ext.is-active').count()) === 1);
  await page.keyboard.press('Alt+5');
  await page.locator('.df-files__row', { hasText: 'analysis.R' }).dblclick();
  await page.locator('.view-line', { hasText: 'summary(cars)' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft'); // cursor inside "cars"
  await page.keyboard.press('Control+Alt+d');
  await page.locator('.df-extpanel').waitFor({ timeout: 5000 });
  check('extension command shows its panel with kernel output', (await page.frameLocator('.df-extpanel').locator('pre').innerText()).includes('Min.') && (await page.frameLocator('.df-extpanel').locator('h2').innerText()) === 'cars');
  await page.frameLocator('.df-extpanel').getByRole('button').click();
  await sleep(500);
  const edText = (await page.locator('.df-editor .view-lines').first().innerText()).replace(/\u00a0/g, ' ');
  check('panel → extension → editor: code inserted on a new line', /summary\(cars\)\s*\n\s*summary\(cars\)/.test(edText));
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Comma');
  await page.locator('.df-theme__item', { hasText: 'Fjord' }).click();
  await sleep(300);
  check('extension theme applies to the whole UI', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim())) === '#1F2633');
  await page.locator('.df-theme__item', { hasText: 'DataForge' }).click();
  await page.keyboard.press('Escape');
  // Sandbox: a development extension cannot reach the network, unapproved APIs, Tauri IPC or the DOM.
  await page.evaluate(() => (window.__dfNextFolder = '/home/demo/dev-ext/probe'));
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Load extension from folder');
  await page.keyboard.press('Enter');
  await page.getByRole('alertdialog').waitFor({ timeout: 4000 });
  await page.getByRole('button', { name: /Allow and enable/ }).click();
  await sleep(1000);
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Sandbox probe');
  await page.keyboard.press('Enter');
  await page.locator('.df-toast', { hasText: 'fetch:' }).waitFor({ timeout: 5000 }).catch(() => {});
  const probe = await page.locator('.df-toast', { hasText: 'fetch:' }).innerText().catch(() => '');
  check('extension sandbox blocks network, unapproved APIs, IPC and DOM', probe.includes('fetch:blocked') && probe.includes('read:denied') && probe.includes('ipc:absent') && probe.includes('dom:absent'));
  if (!probe.includes('fetch:blocked')) console.log('probe:', probe);

  // Remote development against the mock SSH host.
  await page.keyboard.press('Control+Alt+k');
  await page.getByRole('dialog', { name: 'Remote hosts (SSH)' }).waitFor({ timeout: 4000 });
  await page.locator('#df-remote-name').fill('Labor');
  await page.locator('#df-remote-host').fill('ana@lab.example.org:2222');
  await page.locator('#df-remote-user').focus();
  check('host field splits user@host:port', (await page.locator('#df-remote-user').inputValue()) === 'ana' && (await page.locator('#df-remote-port').inputValue()) === '2222' && (await page.locator('#df-remote-host').inputValue()) === 'lab.example.org');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.df-remote__interps li').first().waitFor({ timeout: 5000 });
  check('saving connects and lists the remote interpreters', (await page.locator('.df-remote__interps li').count()) === 2);
  await page.locator('.df-remote__dirs button', { hasText: 'klaszter' }).click();
  await page.waitForFunction(() => document.querySelector('#df-remote-path')?.value === '/home/ana/klaszter');
  await page.getByRole('button', { name: 'Open /home/ana/klaszter' }).click();
  const unsaved = page.getByRole('alertdialog');
  if (await unsaved.waitFor({ timeout: 1500 }).then(() => true, () => false)) await unsaved.getByRole('button', { name: "Don't save" }).click();
  await page.locator('.df-status__remote').waitFor({ timeout: 5000 });
  check('status bar shows the SSH host', (await page.locator('.df-status__remote').innerText()).includes('SSH: Labor'));
  check('title bar names the remote project and host', /klaszter.*Labor/.test(await page.locator('.df-titlebar__project').innerText()));
  await page.locator('.df-files__row', { hasText: 'elemzes.R' }).waitFor({ timeout: 4000 });
  check('files panel lists the remote folder', (await page.locator('.df-files__row', { hasText: 'train.py' }).count()) === 1);
  await page.locator('.df-files__row', { hasText: 'elemzes.R' }).dblclick();
  await page.locator('.df-editor__tab.is-active', { hasText: 'elemzes.R' }).waitFor({ timeout: 4000 });
  check('remote files open in the editor', (await page.locator('.df-editor .view-lines').first().innerText()).includes('meres'));
  await page.keyboard.press('Control+Alt+k');
  await page.getByRole('button', { name: 'New host' }).click();
  await page.locator('#df-remote-host').fill('fail.example');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.df-remote__detail .df-remote__error').waitFor({ timeout: 4000 });
  check('connection errors are explained in the dialog', (await page.locator('.df-remote__detail .df-remote__error').innerText()).includes('authentication failed'));
  await page.keyboard.press('Escape');

  // Command palette + theme switching.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('theme dark');
  await page.keyboard.press('Enter');
  await sleep(200);
  check('palette switches the theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

  // Layout presets.
  await page.keyboard.press('Control+Alt+3');
  await sleep(300);
  check('focus layout shows only the editor', (await page.locator('.dv-groupview').count()) === 1);
  await page.keyboard.press('Control+Alt+1');
  await sleep(300);
  check('analysis layout restores four panels', (await page.locator('.dv-groupview').count()) === 4);

  // Language switch.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('Magyar');
  await page.keyboard.press('Enter');
  await sleep(200);
  check('interface switches to Hungarian', (await page.getByText('Környezet').count()) > 0);

  check('no uncaught page errors', errors.length === 0);
  if (errors.length) console.log(errors);
  await browser.close();
} finally {
  server.kill();
}
process.exit(failures ? 1 : 0);
