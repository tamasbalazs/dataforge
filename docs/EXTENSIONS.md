# DataForge-bővítmények írása

Egy bővítmény egy mappa, amelyben van egy `dataforge-extension.json` manifest, és ha kódot is futtat, egy JavaScript-modul.
Teljes, működő példa: [`examples/extensions/data-summary`](../examples/extensions/data-summary).

```
my-extension/
  dataforge-extension.json
  main.js                 # ES-modul, egyetlen fájl (relatív import nem működik – csomagold egybe)
  snippets/r.json         # VS Code-formátumú snippetek (opcionális)
  themes/my-theme.json    # VS Code- vagy DataForge-téma (opcionális)
```

## Kipróbálás és csomagolás

- **Fejlesztés közben:** a Bővítmények panelen válaszd a **Betöltés mappából** lehetőséget (vagy a parancspalettában a
  *Bővítmény betöltése mappából* parancsot). A **Bővítmények újratöltése** gomb a módosításokat azonnal betölti.
- **Csomagolás:** `pnpm pack:ext my-extension`, ami egy `<név>-<verzió>.dfext` fájlt hoz létre. Ez egy ZIP, amely a
  **Telepítés…** gombbal telepíthető. A telepítő elutasítja a mappán kívülre mutató útvonalakat (zip-slip), a 64 MB-nál
  nagyobb csomagokat és a hibás azonosítókat.

## Manifest

```json
{
  "id": "publisher.name",
  "name": "Megjelenő név",
  "version": "1.0.0",
  "description": "…",
  "author": "…",
  "engines": { "dataforge": "^0.1" },
  "main": "main.js",
  "permissions": ["editor", "kernel"],
  "contributes": {
    "commands": [{ "id": "run", "title": "Valami: futtatás", "keybinding": "Mod+Alt+D" }],
    "panels": [{ "id": "view", "title": "Nézet" }],
    "snippets": [{ "language": "r", "path": "snippets/r.json" }],
    "themes": [{ "label": "Saját téma", "path": "themes/my-theme.json" }]
  }
}
```

**Jogosultságok.** A telepítéskor a felhasználó jóváhagyja őket, és új jogosultság kérésekor újra rákérdez:

| Jogosultság | Mit enged |
|---|---|
| `editor` | az aktív szerkesztő kijelölésének és szövegének olvasása, szöveg beszúrása |
| `kernel` | R/Python-kód futtatása a konzol munkameneteiben (`execute`: látható, `evaluate`: a kimenetet adja vissza) |
| `workspace` | a megnyitott projekt fájljainak listázása és olvasása (csak olvasás, csak a projekten belül) |
| `network` | hálózati hozzáférés (`fetch`, `WebSocket`, …) |

Parancsokat és paneleket csak akkor regisztrálhatsz, ha a `contributes` deklarálja őket. A beépített
billentyűparancsokat nem írhatod felül: ütközés esetén a bővítmény billentyűje kimarad, és a felhasználó értesítést kap róla.

## API (`activate(dataforge)`)

```js
export async function activate(df) {
  await df.commands.register('run', async () => { /* … */ });

  const sel = await df.editor.getSelection();          // { text, word, language, path }      [editor]
  const all = await df.editor.getText();               //                                     [editor]
  await df.editor.insertText('x <- 1', { position: 'newLine' }); // vagy 'cursor' (alapért.) [editor]

  await df.kernel.execute('r', 'summary(cars)');       // a konzolban, látható módon          [kernel]
  const out = await df.kernel.evaluate('python', 'df.describe()'); // kimenet szövegként       [kernel]

  const root = await df.workspace.root();              //                                     [workspace]
  const files = await df.workspace.listFiles();        // projekt-relatív útvonalak           [workspace]
  const text = await df.workspace.readFile('data/a.csv');                                  // [workspace]

  await df.panels.show('view');
  await df.panels.setHtml('view', '<h2>Szia</h2><button id=b>OK</button><script>document.getElementById("b").onclick = () => dataforge.postMessage({ ok: true })</script>');
  df.panels.onMessage('view', (msg) => { /* a panelből jött */ });
  await df.panels.postMessage('view', { hello: 1 });   // a panelben: dataforge.onMessage(fn)

  await df.window.showMessage('Kész', 'success');      // 'info' | 'success' | 'error'
  await df.storage.set('kulcs', { a: 1 });             // bővítményenkénti, megmaradó tároló (≤100 KB/érték)
  const v = await df.storage.get('kulcs');
}
```

- **Futtatási környezet:** a bővítmény saját **Web Workerben** fut. Nincs hozzáférése a DOM-hoz, a DataForge felületéhez
  és a Tauri IPC-hez: minden a fenti API-n megy át, és a host minden hívásnál ellenőrzi a jogosultságot. A
  `network` jogosultság nélkül a worker hálózati primitívjei le vannak tiltva. Ez a korlátozás a `fetch`/XHR/WebSocket
  hívásokra vonatkozik; a modulok dinamikus `import()`-ját ez a verzió nem tiltja, ezért csak megbízható forrásból
  telepíts bővítményt.
- **Panelek:** sandboxolt iframe-ben jelennek meg, szkriptekkel, de saját origin nélkül. A téma színei CSS-változóként
  elérhetők bennük (`var(--surface-1)`, `var(--accent)`, `var(--font-mono)` …), és a téma váltásakor frissülnek.

## Témák

- **Formátumok:** DataForge-téma (`"format": "dataforge-theme/1"`, a tokenek nevével) vagy VS Code-színtéma. A VS Code-témából a
  `colors` (szerkesztő, oldalsáv, kiemelés, hiba/figyelmeztetés, terminál ANSI) és a `tokenColors` (kulcsszó,
  sztring, szám, komment, függvény, típus) kerül át.
- **Olvashatóság:** minden importált színpárt WCAG AA-ra (4,5:1) igazít a DataForge, és jelzi, hány színt módosított.
- **Csak témát tartalmazó bővítmény:** ehhez nem kell `main` és jogosultság sem.
- **Megosztás:** a Beállítások → Megjelenés → *Aktuális exportálása* `.dftheme.json` fájlt ment, ami közvetlenül importálható.

## Snippetek

VS Code-formátum (`prefix`, `body`, `description`); a `$1`, `${1:alap}`, `$0` helyőrzők működnek. R- és Python-fájlokban
a kiegészítési listában jelennek meg, a bővítmény nevével.
