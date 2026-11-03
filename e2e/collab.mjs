// End-to-end: two users in one browser (mock host; the relay runs over a
// BroadcastChannel). Host shares the project, a guest joins, both edit.
// Usage: pnpm build && node e2e/collab.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4181;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    failures++;
    if (extra !== undefined) console.log('   ', extra);
  }
};
const editorText = async (p) => (await p.locator('.df-editor .view-lines').first().innerText()).replace(/ /g, ' ');
const dontSave = async (p) => {
  const d = p.getByRole('alertdialog');
  if (await d.waitFor({ timeout: 1200 }).then(() => true, () => false)) await d.getByRole('button', { name: "Don't save" }).click();
};
const palette = async (p, text) => {
  await p.keyboard.press('Control+Shift+P');
  await p.keyboard.type(text);
  await sleep(200);
  await p.keyboard.press('Enter');
};

try {
  await sleep(1500);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const errors = [];
  const a = await ctx.newPage();
  a.on('pageerror', (e) => errors.push(`host: ${e}`));
  await a.goto(`http://localhost:${PORT}/`);
  // Host: onboarding, open the project and a script.
  await a.getByRole('dialog').waitFor();
  for (const ms of [700, 300, 0]) {
    await a.keyboard.press('Enter');
    await sleep(ms);
  }
  await a.locator('.monaco-editor').first().waitFor();
  await a.keyboard.press('Control+Alt+O');
  await dontSave(a);
  await a.keyboard.press('Alt+5');
  await a.locator('.df-files__row', { hasText: 'analysis.R' }).dblclick();
  await a.locator('.df-editor__tab.is-active', { hasText: 'analysis.R' }).waitFor();

  // Share.
  await a.keyboard.press('Control+Alt+l');
  await a.getByRole('dialog', { name: 'Share project' }).waitFor();
  await a.locator('#df-collab-name').fill('Anna');
  await a.getByRole('button', { name: 'Start sharing' }).click();
  await a.locator('#df-collab-invite').waitFor({ timeout: 5000 });
  const invitation = await a.locator('#df-collab-invite').inputValue();
  check('sharing produces an invitation link', /^dataforge:\/\/join\/127\.0\.0\.1:\d+\/[a-z0-9]+$/.test(invitation), invitation);
  check('status bar shows the shared session', (await a.locator('.df-status__collab').innerText()).includes('Sharing'));

  // Guest joins from a second window.
  const b = await ctx.newPage();
  b.on('pageerror', (e) => errors.push(`guest: ${e}`));
  await b.goto(`http://localhost:${PORT}/`);
  await b.locator('.df-status__kernel').first().waitFor();
  await sleep(2000);
  await palette(b, 'Join a session');
  await b.getByRole('dialog', { name: 'Join a session' }).waitFor();
  await b.locator('#df-collab-inv').fill('dataforge://join/127.0.0.1:1/' + 'x'.repeat(32));
  await b.locator('#df-collab-name').fill('Béla');
  await b.getByRole('button', { name: 'Join', exact: true }).click();
  await b.locator('.df-toast', { hasText: 'Could not join' }).waitFor({ timeout: 5000 });
  check('a wrong invitation is refused with a message', true);
  await b.locator('#df-collab-inv').fill(invitation);
  await b.getByRole('button', { name: 'Join', exact: true }).click();
  await dontSave(b);
  await b.locator('.df-titlebar__project', { hasText: 'shared' }).waitFor({ timeout: 6000 });
  check('guest sees the shared project', (await b.locator('.df-titlebar__project').innerText()).includes('projekt'));
  await b.keyboard.press('Alt+5');
  await b.locator('.df-files__row', { hasText: 'analysis.R' }).waitFor({ timeout: 4000 });
  check("guest's Files panel lists the host's files", (await b.locator('.df-files__row', { hasText: 'model.py' }).count()) === 1);
  await a.locator('.df-collab__peer', { hasText: 'Béla' }).waitFor({ timeout: 4000 });
  check('host sees the guest in the participants list', true);

  // Co-editing.
  await b.locator('.df-files__row', { hasText: 'analysis.R' }).dblclick();
  await b.locator('.df-editor__tab.is-active', { hasText: 'analysis.R' }).waitFor();
  await sleep(500);
  check('guest opens the shared file', (await editorText(b)).includes('summary(cars)'), await editorText(b));
  await b.locator('.df-editor .view-lines').first().click();
  await b.keyboard.press('Control+End');
  await b.keyboard.type('# Béla itt járt');
  await sleep(600);
  check("guest's typing appears in the host's editor", (await editorText(a)).includes('# Béla itt járt'), await editorText(a));
  await a.locator('.df-editor .view-lines').first().click();
  await a.keyboard.press('Control+Home');
  await a.keyboard.type('# Anna is\n');
  await sleep(600);
  const both = [await editorText(a), await editorText(b)];
  check("host's typing appears for the guest; both see the same text", both[1].includes('# Anna is') && both[0] === both[1], both);
  await sleep(500);
  check("host sees the guest's caret with a name label", (await a.locator('.df-peer-caret').count()) >= 1);
  check('the shared document is marked unsaved for the guest', (await b.locator('.df-editor__tab.is-active .is-dirty').count()) === 1);
  await b.keyboard.press('Control+s');
  await sleep(800);
  check('saving from the guest writes through the host (both tabs clean)', (await a.locator('.df-editor__tab.is-active .is-dirty').count()) === 0 && (await b.locator('.df-editor__tab.is-active .is-dirty').count()) === 0);

  // Chat.
  await b.keyboard.press('Control+Shift+P');
  await b.keyboard.type('Collaboration');
  await b.keyboard.press('Enter');
  await b.locator('.df-collab__chat-form input').fill('Szia Anna!');
  await b.keyboard.press('Enter');
  await a.locator('.df-collab__chat li', { hasText: 'Szia Anna!' }).waitFor({ timeout: 3000 });
  check('chat messages reach the host', true);

  // Running code needs the "run" role.
  await b.locator('.df-editor .view-lines').first().click();
  await b.keyboard.press('Control+Home');
  await b.keyboard.press('Control+Enter');
  await b.locator('.df-console__entry', { hasText: 'cannot run code' }).waitFor({ timeout: 4000 }).catch(() => {});
  check('an editor cannot run code in the host kernel (and is told why)', (await b.locator('.df-console__entry', { hasText: 'cannot run code' }).count()) > 0);
  await a.locator('.df-collab__peer', { hasText: 'Béla' }).locator('select').selectOption('run');
  await b.locator('.df-toast', { hasText: 'Runner' }).waitFor({ timeout: 3000 });
  check('the guest is told about the new role', true);
  await b.locator('.df-editor .view-lines').first().click();
  await b.keyboard.press('Control+End');
  await b.keyboard.press('Enter');
  await b.keyboard.type('x <- 42');
  await b.keyboard.press('Control+Enter');
  await a.locator('.df-console__by', { hasText: 'Béla' }).waitFor({ timeout: 5000 });
  check("a runner's code runs in the host's console, labelled with their name", true);
  await sleep(800);
  check("the guest's console shows the run", (await b.locator('.df-console__input', { hasText: 'x <- 42' }).count()) >= 1);

  // Read-only viewer.
  await a.locator('.df-collab__peer', { hasText: 'Béla' }).locator('select').selectOption('view');
  await sleep(500);
  const before = await editorText(a);
  await b.locator('.df-editor .view-lines').first().click();
  await b.keyboard.type('NEM SZABAD');
  await sleep(600);
  check("a viewer's editor is read-only and the host's text is unchanged", !(await editorText(b)).includes('NEM SZABAD') && (await editorText(a)) === before);

  // Follow the host.
  await b.locator('.df-collab__peer', { hasText: 'Anna' }).getByRole('button', { name: /Follow Anna/ }).click();
  await a.keyboard.press('Alt+5');
  await a.locator('.df-files__row', { hasText: 'model.py' }).dblclick();
  await b.locator('.df-editor__tab.is-active', { hasText: 'model.py' }).waitFor({ timeout: 5000 }).catch(() => {});
  check('following opens what the host opens', (await b.locator('.df-editor__tab.is-active').innerText()).includes('model.py'));

  // Ending the session returns the guest to their own project.
  await palette(a, 'Stop sharing');
  await b.locator('.df-toast', { hasText: 'ended the session' }).waitFor({ timeout: 5000 });
  await sleep(1000);
  check('the guest leaves when the host stops', !(await b.locator('.df-titlebar__project').innerText()).includes('shared'));
  check('no uncaught page errors', errors.length === 0, errors);
  if (failures) await b.screenshot({ path: '/tmp/claude-0/shots/collab-b-end.png' });
  await browser.close();
} finally {
  server.kill();
}
process.exit(failures ? 1 : 0);
