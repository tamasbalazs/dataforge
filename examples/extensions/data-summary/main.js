// Adat-összefoglaló — a DataForge extension API example.
// Runs in a sandboxed worker; everything goes through the `df` object.

const NAME = /^[A-Za-z_.][\w.]*$/;

export async function activate(df) {
  let lastCode = '';

  await df.commands.register('describe', async () => {
    const sel = await df.editor.getSelection();
    const name = (sel.text || sel.word || '').trim();
    const lang = sel.language === 'python' ? 'python' : 'r';
    if (!NAME.test(name)) {
      await df.window.showMessage('Jelölj ki egy változónevet a szerkesztőben (pl. eladasok).', 'info');
      return;
    }
    lastCode = lang === 'r' ? `summary(${name})` : `${name}.describe(include="all")`;
    const text = await df.kernel.evaluate(lang, lastCode);
    await df.panels.show('summary');
    await df.panels.setHtml('summary', render(name, lang, text, lastCode));
  });

  // The panel can ask us to put the code into the editor (reproducible next step).
  df.panels.onMessage('summary', async (msg) => {
    if (msg && msg.type === 'insert' && lastCode) await df.editor.insertText(lastCode, { position: 'newLine' });
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function render(name, lang, text, code) {
  return `
<style>
  body { padding: 16px 20px; }
  h2 { margin: 0 0 4px; font-size: 15px; }
  .muted { color: var(--text-muted); font-size: 12px; margin: 0 0 12px; }
  pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow: auto; font: 12px/1.5 var(--font-mono); }
  button { margin-top: 12px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--accent); color: var(--accent-fg); font: 500 12px var(--font-ui); cursor: pointer; }
</style>
<h2>${esc(name)}</h2>
<p class="muted">${lang === 'r' ? 'R' : 'Python'} · <code>${esc(code)}</code></p>
<pre>${esc(text)}</pre>
<button id="insert">Kód beszúrása a szerkesztőbe</button>
<script>
  document.getElementById('insert').addEventListener('click', () => dataforge.postMessage({ type: 'insert' }));
</script>`;
}
