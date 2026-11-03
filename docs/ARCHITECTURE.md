# DataForge – architektúra

## Rendszerkép

```
┌──────────────────────────── FRONTEND (WebView, React) ─────────────────────────┐
│ Workbench: dockview layout · parancsregiszter · billentyűk · i18n · eseménybusz │
│ Panelmodulok: Editor · Console · Environment · Plots · (DataViewer, Git, …)      │
│ ui-kit ◄── design tokenek (src/design/tokens.ts) → CSS vars, Monaco-téma, plot-téma│
└───────────────▲────────────────────────────────────────────────────────────────┘
                │ Host interfész (src/core/host.ts)
                │   Tauri: invoke() + események     |  böngésző: mock host
┌───────────────┴──────────────────── HOST (Rust) ───────────────────────────────┐
│ KernelManager ──ZeroMQ (Jupyter wire 5.3, HMAC)──► IRkernel / ipykernel         │
│                                                   + DataForge segédkód            │
│ Bridge (127.0.0.1 HTTP + token) ◄──── py$x / r.x a kernelekből                    │
│ pty (terminálok) · git (nem interaktív futtató, engedélylista)                   │
│ envdetect (R/Python felismerés, cache) · fájl I/O · LSP · procs (render, uv) · …  │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Kommunikáció

| Útvonal | Megoldás |
|---|---|
| UI → Host | `Host` interfész. Tauri alatt `invoke` parancsok: `kernel_start`, `kernel_execute`, `kernel_call`, `kernel_complete`, `detect_interpreters`, … |
| Host → UI | `kernel-event` esemény: IOPub-üzenetek és szintetikus `dataforge:*` életciklus-események |
| Host → kernel | Jupyter wire protocol: shell, control, iopub. A belső (silent) kérések kimenetét a Host kiszűri. |
| Segédhívások | `kernel_call(func, args)`. A kernelben a `.dataforge$call(...)` (R) vagy a `_dataforge.call(...)` (Python) fut, és JSON-fájlba ír. Ez nem szennyezi a konzolt és a változóteret. |
| Modul ↔ modul | `core/bus.ts` típusos eseménybusz: `kernel:execution-start`, `kernel:output`, `kernel:execution-done`, `kernel:ready`, `plots:added`, … |

Az üzenet-azonosítót (`msg_id`) a frontend generálja. Így a kimenet akkor is hozzárendelhető, ha megelőzi az `invoke` válaszát.
A futtatási kérések nyelvenként szigorúan sorrendben indulnak.

## Panelmodul-szerződés

```ts
interface PanelModule {
  id: string; title: I18nKey; icon: LucideIcon;
  component: LazyExoticComponent<ComponentType>;   // lustán betöltve
  install?: () => Dispose;                          // store ↔ busz bekötés
  keybinding?: string;
}
```

A beépített panelek ugyanezen a szerződésen keresztül regisztrálnak, mint később a bővítmények.

## Adatnézegető

```
DataGrid (virtualizált, csak a látható sorok/oszlopok)
   │ onVisible(first,last)
   ▼
dataStore ── blokkok (100 sor), legfeljebb 80 blokk, a nézettől legtávolabbiak kiesnek
   │ kernel_call('data_page' | 'data_info' | 'data_stats')
   ▼
segédkód a kernelben: szűrés → keresés → rendezés → sorindex (lekérdezésenként cache)
   → csak a kért szelet formázva (oszloponként, hiányzó = null)
```

- Lekérdezésváltáskor 120 ms-os késleltetés van, így a gyors kattintások nem töltik meg elavult kérésekkel a kernel sorát.
  A generációszámláló eldobja a késve érkező válaszokat.
- A görgetési magasság 8 millió pixelnél tömörítődik (`scrollGeometry`). Így tetszőleges sorszám görgethető, és a böngésző
  magassági korlátja sem jelent gondot.
- A `View()` az R-ben (az `utils::View` helyett) és a Pythonban (`builtins.View`) egy
  `application/vnd.dataforge.view+json` típusú `display_data` üzenetet küld, erre nyílik meg a fül.

## Nyelvi szerverek

- **Host (`lsp.rs`):** felismeri és elindítja a szervert, és `Content-Length` keretekkel továbbítja a stdio-forgalmat
  (`lsp_start`, `lsp_send`, `lsp-event`).
- **UI (`src/lsp`):** saját, kicsi JSON-RPC kliens nyelvenként.
  - Csak a szerkesztő dokumentumait szinkronizálja (inkrementálisan, ha a szerver engedi), a konzolbemeneteket nem.
  - Monaco-providereket regisztrál, és megválaszolja a `workspace/configuration` kéréseket (pl. a Python-értelmező útvonalát).
  - A Monaco beépített LSP-kliensét azért nem használja, mert az minden modellt minden szervernek elküldene, gyökérkönyvtár nélkül.

## Projektek

```
openProject(root)
  ├─ mentetlen fájlok? → kérdés (mentés / eldobás / mégse)
  ├─ settings.workdir = root, a nyitott fájlok megjegyzése a régi projekthez
  ├─ host.projectWatch(root)   → 'fs-changed' események (250 ms-os kötegek)
  ├─ host.projectInspect(root) → renv, .Rproj, venv-ek (vizsgálva), pyproject, uv.lock, uv
  ├─ kernelek újraindítása (cwd = root; az értelmezőt a projekt adja: .venv)
  └─ nyelvi szerverek újraindítása (rootUri = root), a projekt fájljainak visszaállítása
```

- Az értelmezőt egy `setInterpreterResolver` hook választja, így a kernelszolgáltatás nem függ a projektmodultól.
- **R renv-ben:** az indítókód `.libPaths(unique(c(.libPaths(), <IRkernel könyvtára>))); IRkernel::main()`. A projekt
  könyvtára marad elöl, az IRkernel és függőségei pedig a lista végéről töltődnek. Ezt integrációs teszt ellenőrzi.
- A háttérfeladatokat (venv, `uv sync`) a host futtatja és streameli a kimenetüket. A felület folyamatjelző toastot és naplót mutat.

## R↔Python Bridge

```
R:  x <- py$df                                   Python:  df = r.x
     │ GET /pull?lang=python&name=df&token=…             │ GET /pull?lang=r&name=x&token=…
     ▼                                                    ▼
Host (bridge.rs) ── call_helper('bridge_export', {name, path}) ──► a MÁSIK kernel
     │                 (csendes, a konzolban nem látszik)          dfc-mappát ír a cserekönyvtárba
     ◄─────────── {path} ─────────────────────────────────────────
a hívó kernel beolvassa a mappát, majd törli
```

- **Írás** (`py$x <- v`, `r.x = v`): a hívó írja a dfc-mappát, a `/push` végpont a cél kernel `bridge_import`
  függvényét hívja. Ez a kernel beolvassa és törli a mappát.
- **Biztonság:**
  - csak a 127.0.0.1 címen figyel, véletlen token védi;
  - a nevek ellenőrzöttek: csak azonosító-karakterek, így útvonal vagy kód nem csempészhető be;
  - importálni csak a 0700-as jogú cserekönyvtárból lehet.
- **Env a kernelek számára:** `DATAFORGE_BRIDGE_URL`, `DATAFORGE_BRIDGE_TOKEN`, `DATAFORGE_BRIDGE_DIR`. A `no_proxy`
  változó kiegészül a 127.0.0.1-gyel, mert az R `url()` a libcurlön át követné a proxyt.
- **Holtpont ellen:** a host legfeljebb 5 percig vár a foglalt kernelre, utána hibát ad vissza.

### dfc – a csereformátum (v1)

```
manifest.json   {"version":1, "kind":"frame"|"vector"|"matrix"|"json"|"null",
                 "nrow"/"n"/"dims", "rownames"|"names"|"colnames", "columns":[{name,type,file,levels?,tz?}]}
c1, c2, …       nyers little-endian oszlopok: double → float64 (NA = NaN), int/logical/factor → int32 (NA = INT_MIN,
                pontosan az R NA_integer_ ábrázolása), date → float64 nap 1970-01-01 óta, datetime → float64 másodperc (UTC) + tz
cN.json         szövegoszlop: JSON-tömb, hiányzó = null
value.json      kind = "json": listák / dict-ek (jsonlite ↔ json)
```

- Az R oldalon `writeBin`/`readBin`, a Python oldalon `numpy.tofile`/`fromfile` olvassa és írja. Nincs szükség Arrowra
  vagy más külső függőségre, és egymillió sor is tizedmásodpercek alatt átmegy.
- Pandas nélkül a Python oldal a standard `array` modullal kezeli a vektorokat és skalárokat.
- A felület „Másolás ide” gombja nem rejtett csatornát használ: látható kódsort futtat a cél konzolban
  (`x = r.x` / `x <- py$x`), így az átadás a munkamenet-előzményben és a szkriptben is reprodukálható.
- R alatt a `$.dataforge_bridge` és társai a `registerS3method`-dal regisztrálódnak. Az R ≥ 3.6 az S3-metódusok
  keresésekor kihagyja a csatolt környezeteket, ezért a `dataforge:tools` környezetben nem találná meg őket.

## Quarto / R Markdown előnézet

```
Ctrl+Shift+K / mentés ─► previewStore.renderPreview(path)
   ├─ motor: .qmd/.md → quarto render … --output-dir <tmp> -M embed-resources:true
   │         .Rmd     → R -e 'rmarkdown::render(…, output_dir = <tmp>)'
   ├─ env: QUARTO_PYTHON / RETICULATE_PYTHON / QUARTO_R = a projekt értelmezői; UTF-8 locale, ha nincs
   ├─ host.procRun → streamelt napló (ANSI nélkül) → exit 0 → <tmp>/<név>.html beolvasása
   └─ Előnézet panel: srcdoc iframe (sandbox: allow-scripts allow-popups)
        └─ beinjektált szkript: görgetési pozíció (postMessage) + külső linkek a rendszerböngészőbe
```

- A `<tmp>` a forrásútvonal hash-éből képzett mappa a rendszer ideiglenes könyvtárában, így semmi sem kerül a repóba.
- Egyszerre egy render fut: az új render leállítja az előzőt, a késve érkező eseményeket pedig a futásazonosító szűri ki.
- A chunkfelismerés (`panels/editor/chunks.ts`) a `{r}`, `{python}` és ```` ```r ```` kerítéseket ismeri, a `#|` opciósorokat elhagyja.

## Terminál

```
TerminalPanel ─ mountTerminal(id, el) ─► xterm.js példány (React-en kívül élő DOM-elem, áthelyezhető)
      ▲                                     │ onData            ▲ write(Uint8Array)
      │                                     ▼                   │
      │                            host.ptyWrite        'pty-event' {id, base64, exit}
      │                                     ▼                   │
Rust pty.rs: portable-pty ── olvasószál (64 KB-os blokkok) ─────┘
```

- A kimenet nyers bájtként (base64-ben) halad. A több bájtos UTF-8 karaktereket az xterm dekódere rakja össze, így a
  blokkhatáron kettévágott „ő” sem sérül.
- A venv a `DATAFORGE_PATH_PREPEND` változóval kerül a PATH elejére: a host a saját PATH-ja elé fűzi, a változó
  maga nem jut el a shellig.
- Billentyűk: a globális kezelő `.xterm` fókusz esetén csak a `terminalAllows()` által engedett akkordokat veszi el.

## Git

- **Host (`git.rs`):**
  - `git -C <gyökér> -c core.quotepath=off <args>`, a következő környezettel: `GIT_TERMINAL_PROMPT=0`,
    `GIT_SSH_COMMAND=ssh -o BatchMode=yes`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`.
  - Csak engedélyezett alparancsok futhatnak; a `config`-ból csak olvasni lehet. Így a felületről nem indítható tetszőleges program.
- **UI:**
  - A `gitParse.ts` tiszta függvényekkel értelmezi a kimeneteket: `status --porcelain=v2 -z`, `log` (`\x1f`/`\x1e` határolókkal),
    `for-each-ref`, `--name-status`. Valódi git-kimeneteken tesztelt.
  - A `gitStore.ts` a műveleteket és az állapotot kezeli. Minden művelet után frissít; hibánál a git stderr első
    érdemi sorát mutatja.
- **Frissítés:**
  - fájlfigyelő, amely a `.git/HEAD`, `index`, `refs/*` és `MERGE_HEAD` változását is jelzi;
  - ablakfókusz;
  - projektváltás.
- **Diff:**
  - Dinamikus `diff:<bal>:<jobb>:<útvonal>` panel. A két oldal: `HEAD`, `:` (index), `worktree`, `empty` vagy egy commit hash.
  - A munkakönyvtár- és index-oldalú diffek a Git-állapottal együtt frissülnek.
- **Konfliktusok:**
  - A `findConflicts` ismeri a diff3 (`|||||||`) stílust is.
  - A feloldás `pushEditOperations` hívással történik, így visszavonható.
  - A dekorációk és a CodeLens minden nyelven működnek.
- **Monaco worker:** a belépési pont az `editor.worker.js`. Az `editor.worker.start.js` csak definiálja a `start()`
  függvényt, és korábban emiatt nem futott a worker. Ezt a diff-nézet fejlesztése közben vettük észre.

## Hibakereső

```
                 ┌ Python adapter ─ host.kernelDebug ─► debug_request (control) ─► ipykernel/debugpy (DAP)
debugStore ──────┤                      ◄── debug_event (IOPub): stopped / continued
 (UI, egységes)  └ R adapter ──────── host.rDebug ─► DebugHub (bridge.rs) ◄── long poll ── R: dbg_pause()
                                                          ▲  események/válaszok JSON-fájlban ──┘
```

- **Python:**
  - `initialize` → `attach` → `debugInfo` (a `tmpFilePrefix` a cellakeretek kiszűréséhez kell) → `setBreakpoints` →
    `configurationDone`.
  - A `debugfile(path)` valódi fájlnévvel fordít, ezért a debugpy-töréspontok közvetlenül illeszkednek.
  - Leállítás: kernelmegszakítás, majd `continue`.
- **R:**
  - A `debugSource()` kifejezésenként értékel ki. A `dbg_instrument()` minden `{` blokk utasítása elé
    `.dataforge$dbg_step(sor, fájl)` hívást tesz, a függvénydefiníciók törzsébe is; a `srcref` megmarad.
  - A `dbg_step` a keretmélység (`sys.nframe`) alapján dönt:
    - átlépés: mélység ≤ D;
    - kilépés: mélység < D;
    - belépés: minden lépés;
    - töréspont: fájl és sor egyezése.
  - Szünetben a `dbg_pause` hosszú lekérdezéssel vár a `/debug/wait` végponton. A `variables`, `evaluate` és
    `setBreakpoints` parancsokra a választ fájlban küldi vissza (`/debug/reply?id=…`).
  - A leállítás egy `dataforge_debug_stop` feltételt dob, amit a `debugSource` elkap. Az `invokeRestart("abort")` az
    IRkernelt is leállítaná, ezt teszt ellenőrzi.
  - A hub egy új `stopped` eseménykor kiüríti a korábban sorba állított mozgásparancsokat.
- **Szerkesztő:**
  - glyph-margó dekorációk (`TrackedRangeStickiness`), így a töréspont a sorával együtt mozog;
  - a szüneteltetett sor kiemelése;
  - a `setRevealHook` megnyitja a fájlt, és a megfelelő sorra ugrik.

## Reprodukálhatóság

```
analyzeProject()
  ├─ host.reproFiles(root)        Rust: rekurzív lista; .git/.venv/renv/library/cache-ek nélkül
  ├─ scan.ts                      csomagok/importok, adathivatkozások, kockázatok (kommentek kiszűrve; qmd/Rmd
  │                               chunkonként, valódi sorszámmal; ipynb cellánként)
  ├─ kernel: repro_info           R: installed.packages + package_dependencies(recursive) → renv.lock mezők
  │                               Python: packages_distributions + requires (markerek kiértékelve) → lezárt
  ├─ host.reproHash               SHA-256 (64 KB-os blokkokban, nagy fájlokra is)
  └─ gitExec                      HEAD, ág, porcelain-állapot, origin
exportBundle()
  └─ bundle.ts → host.reproWrite  ZIP (.part fájlba, majd átnevezés) vagy új, üres mappa
```

- A csomagverziókat mindig a futó kernel adja, vagyis azt rögzítjük, ami ténylegesen futott. A projekt saját `renv.lock`-ja a
  kóddal együtt bekerül, de az `environment/R/renv.lock` a telepített állapotot tükrözi.
- A `reproduce.sh` külön könyvtárba állítja vissza az R-csomagokat
  (`renv::restore(library = ".r-library")` + `R_LIBS`), így nem kell renv-projektet aktiválni. Python esetén venv-et
  használ. Az ellenőrzőösszegek a kihagyott adatfájlokra is szerepelnek, így a pótolt adat is ellenőrizhető.
- Az `realBundle.test.ts` opcionálisan ugyanezzel a kóddal, valódi R/Python/git mellett épít csomagot. Így ellenőriztük, hogy a
  `reproduce.sh` valóban újraépíti és lefuttatja az elemzést, és hogy egy átírt adatbájtot kiszűr.

## Bővítmények

```
ExtensionsPanel / parancsok
        │ enable → requestConsent (jogosultságok)
        ▼
extensionHost ── new Worker(blob: prelude + jogosultságok, type: module)
   │   ▲              └─ import(blob: main.js) → activate(dataforge)
   │   │ postMessage {call, method, args}
   │   └─ authorize(manifest, method, args)  → dispatch (szerkesztő, kernel/ext_eval, workspace, panelek, storage)
   ├─ parancsok → command registry (literal cím, ütköző billentyű kihagyva)
   ├─ panelek → dockview 'extpanel' → iframe sandbox="allow-scripts" (téma CSS-változók + dataforge.postMessage)
   ├─ snippetek → Monaco completion provider (r, python)
   └─ témák → themeStore.extensionThemes
```

- **Elszigetelés:** a workerben nincs `window`, DOM és `__TAURI_INTERNALS__`. A host csak az `authorize` által engedett
  metódusokat hajtja végre. A `kernel.evaluate` az `ext_eval` segédfüggvényt hívja, amely a konzol névterében fut, és
  a kimenetet adja vissza.
- **Telepítés (`ext.rs`):** a `.dfext` egy ZIP. A manifestet a gyökérben vagy egyetlen felső mappában keresi, az
  `enclosed_name()` kiszűri a zip-slip útvonalakat. A kicsomagolás egy staging mappába történik, majd átnevezéssel
  cserél, így egy félbemaradt telepítés nem rontja el a meglévőt.
- **Fejlesztői mappák:** a helyükön töltődnek be, és azonos azonosító esetén elsőbbséget kapnak a telepített példánnyal szemben.

## Témák

- `CustomTheme = { type: light|dark, colors: Partial<Palette>, ansi? }`. A `core/theme.ts` az aktív témát
  `applyTheme(mode, overrides)` hívással alkalmazza, és a `useThemeMode`-ban közzéteszi:
  - a Monaco a témáit `defineTheme` hívással helyben újradefiniálja;
  - a grafikonok `plotTheme`-et kapnak, a terminál ANSI-színeket;
  - a konzol a kiszínezett kódot újraszínezi.
- **VS Code-import (`fromVSCode`):**
  - a `colors` kulcsait a felületi tokenekre képezi le; a hiányzó felületeket a háttér és az előtér keverékéből számolja;
  - a `tokenColors` esetén a legspecifikusabb scope-illesztés dönt;
  - végül az `ensureContrast` minden `contrastPairs` párt 4,5:1-re emel.

## Távoli fejlesztés

```
RemoteDialog / parancsok ── remoteStore (profilok a beállításokban, kapcsolatállapot)
        │ remote_connect(profile)                       │ openProject("ssh://<id>/út")
        ▼                                               ▼
RemoteManager (remote.rs) ◄──── lib.rs: minden útvonal-alapú parancs "ssh://" előtaggal ide kerül
   ├─ run(script, args, stdin): ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=<tmp>/%C -T host 'sh -c …'
   ├─ fájlok: find -printf (lista), cat (olvasás), cat > tmp && mv (írás), mkdir/:>, mv -n, freedesktop-kuka
   ├─ projekt: renv/venv/.Rproj/.git felismerés + venv-próba a gépen; git: git -C (ugyanaz az engedélylista)
   ├─ terminál: helyi PTY-ben ssh -tt host 'cd …; exec $SHELL -l' (ez kérhet jelszót)
   └─ kernel: Kernel::launch_remote
        ssh -o ControlPath=none -o ExitOnForwardFailure=yes -L l₁:127.0.0.1:r₁ … (5 port) host '<kernel_script>'
          kernel_script: kapcsolatfájl (umask 077) → kernel indítása → "DFPID n" → őrfolyamat (cat <&3; kill)
        helyben: ZMTP-üdvözlés megvárása a továbbított portokon → a szokásos zmq-kapcsolat
```

- **Útvonalak:** a felület a távoli mappát `ssh://<profilazonosító>/abszolút/út` alakban kezeli; a Rust oldalon a
  `remote::parse` normalizál, és a `..` szegmenseket elutasítja. Ami a gépen fut (kernelkód, debugger), az a sima
  távoli utat kapja: `kernelPath()`; a debugger keretei a `workspacePath()`-szal képződnek vissza.
- **Biztonság:** minden távoli szkript fix szöveg, a változó adat pozicionális argumentumként, POSIX-idézve megy át.
  A profil gépneve és felhasználója nem kezdődhet kötőjellel (nem lehet `ssh`-opció). Jelszót a DataForge nem kezel.
- **Segédhívások:** helyben a kernel egy fájlba írja az eredményt; távoli kernelnél ez nem olvasható, ezért a
  segédfüggvény `\x1eDFJSON…\x1e` jelölők közé írja a stdoutra, a host pedig a belső kérés IOPub-folyamából gyűjti ki
  (a felületre nem jut el). Az IRkernel a `silent` kérések kimenetét eldobja, ezért R-nél `silent=false,
  store_history=false` megy (a végrehajtásszámláló így sem nő).
- **Életciklus:** a kernel helyi „gyereke” maga az ssh-folyamat. Az ssh stdinje nyitva marad; ha bezárul (kilépés,
  összeomlás, `kill`), a távoli őrfolyamat leállítja a kernelt és törli a kapcsolatfájlt. A megszakítás `kill -INT`
  a távoli PID-re a multiplexelt kapcsolaton.
- **Leállás jelzésre:** a SIGTERM/SIGINT/SIGHUP a normál kilépési utat indítja (minden kernel leáll, a távoliak
  is). Linuxon a helyi kernelek `PR_SET_PDEATHSIG`-et kapnak, így `kill -9` vagy összeomlás után sem maradnak
  árván (az ipykernel a `JPY_PARENT_PID`-et is figyeli, az IRkernel nem).
- **Ami helyi marad:** LSP, előnézet (Quarto/rmarkdown), R-hibakereső és Bridge (helyi HTTP) – távoli projektben
  ezek érthető üzenettel kikapcsolnak. A reprodukálhatósági export a gépen listáz és hashel, a forrásfájlokat
  `download`-dal egy ideiglenes mappába húzza, majd helyben írja a csomagot.

## Közös munka

```
Megosztó DataForge                                        Vendég DataForge
 HostSession (collab/session.ts)                            GuestSession
   ├─ Y.Doc fájlonként ◄── bindModel ── Monaco-modellek       ├─ Y.Doc-ok ◄── bindModel ── Monaco (collab://sid/…)
   ├─ RPC: fs.*, project.info, kernel.* (szerep-ellenőrzés)  ├─ rpc() ◄── core/hostRouter (kernel*, fs*, readText…)
   ├─ kernelesemények, futtatások, fájlváltozások → mind      ├─ kev/exec → kernels.ts (konzol, Környezet, grafikonok)
   └─ jelenlét, csevegés, szerepek, eltávolítás               └─ jelenlét, csevegés
        │ host token                                                   │ guest token (meghívó)
        ▼                                                              ▼
   collab.rs relay (127.0.0.1 vagy 0.0.0.0, véletlen port) ◄──────────── WebSocket
     vendég → {from, data} csak a megosztónak; megosztó → {to: id|"*", except?, data}; kick; join/leave
```

- **Továbbító (`collab.rs`):** tokio-tungstenite. Két véletlen 256 bites token, állandó idejű összehasonlítással.
  Egyszerre egy megosztó, legfeljebb 32 vendég, 16 MB-os üzenetkorlát. A továbbító nem értelmezi a tartalmat, csak
  címez. Csillag topológia: minden vendégüzenet a megosztóhoz megy, így a jogosultságot egyetlen helyen lehet
  ellenőrizni.
- **Dokumentumok:** fájlonként egy Y.Doc (`content` Y.Text) a megosztónál; a projekt-relatív út azonosítja. A
  megosztó a frissítéseket a feliratkozott vendégeknek küldi tovább, a forrás kivételével. A nézők frissítéseit
  eldobja. A `bindModel` a Monaco-változásokat fordított eltolássorrendben alkalmazza a Y.Textre, a távoli deltákat
  pedig `applyEdits`-szel a modellre.
- **Jelenlét:** a kurzorok `Y.RelativePosition`-ként utaznak, így a párhuzamos szerkesztés közben is a helyükön
  maradnak. A megjelenítés dekoráció, személyenkénti CSS-osztállyal (szín, névcímke).
- **Vendég-munkaterület:**
  - a `wrapHost` minden host-hívást körbevesz: vendégként a kernelhívások és a `collab://` utak a munkamenetbe mennek;
  - a panelek ezért változatlanok; a kernel-azonosító a nyelv;
  - a megosztó a kernelesemények mellett a futtatások kezdetét is továbbítja, a vendég `trackExternalExecution`-nel jeleníti meg;
  - a vendég saját futtatásait a saját `msgId`-je azonosítja, így a válaszok a saját konzolsorához kerülnek.
- **Szerepek:** `RPC_ROLE` + `READONLY_HELPERS` (protocol.ts). A szerepet a megosztó ellenőrzi; a vendég oldali
  ellenőrzés csak kényelmi (csak olvasható szerkesztő, érthető hibaüzenet).
- **Böngészős mock:** a `host.mock.collab.ts` ugyanazokat a szabályokat BroadcastChannelen valósítja meg, így az
  e2e teszt egy böngészőben két felhasználót futtathat.

## Akadálymentesség

- **Fülek:** az APG „lapfülek bezárással” mintája szerint a fül belsejében nincs második fókuszálható elem. A
  bezáró ikon csak egérrel működik, billentyűzettel a fókuszban lévő fül `Delete`-tel zárul (`aria-keyshortcuts`).
  A dockview a panel címét használja a fül akadálymentes neveként, ezért a címek lefordítva kerülnek be, és
  nyelvváltáskor frissülnek.
- **Ablakok:** a `useFocusTrap` a következő képkockán fókuszál: a `data-autofocus` mezőre, ennek híján a tartalom
  első vezérlőjére (nem a fejléc bezáró gombjára). Tabbal körbe zár, bezáráskor visszaadja a fókuszt.
- **Színek:** a `contrastPairs` minden szövegpárt, köztük a halvány szöveget a kiemelt háttereken és a
  `dangerFg`-t a veszélyes gombokon, mindkét témában 4,5:1 fölött tart (egységteszt). A résztvevők színein a
  szöveg fekete vagy fehér, amelyik jobban olvasható.
- **Ellenőrzés:** az `e2e/a11y.mjs` axe-core-ral, az `e2e/keyboard.mjs` billentyűzetes bejárással fut (`pnpm a11y`, CI).

## Stan és háttérfeladatok

```
Stan-szerkesztő (Monaco, stan/language.ts)
  └─ gépelés → 350 ms → stan/stanc.ts ── postMessage ──► Web Worker (blob)
                                                            PRELUDE: fetch/XHR/WebSocket/importScripts tiltva
                                                            stanc.js (stanc3 v2.36.0): check | format | info
        markerek ◄── parseMessages + placeUnlocated + includeAware ◄──┘

Mintavételi ablak (jobs/jobDialog.tsx)
  └─ jobsStore.startStanJob: adatlista → konzol: saveRDS(~/.dataforge/job-inputs/…)
       └─ host.jobStart(workdir, {program: Rscript, files: {job.R}}) ──► jobs.rs
                                                                         Place::Local  → sh -c '<script>'
                                                                         Place::Remote → RemoteManager.run (SSH)
  ◄── jobPoll(id, offset): {info, data (UTF-8 határon vágva), nextOffset} ── 1 s helyben / 2 s SSH-n
  └─ progress.ts: foldProgress (láncok, divergenciák, hibák) → Feladatok panel, státuszsor, értesítés
```

- **stanc3 a böngészőben:** a hivatalos `stanc.js` egy blob-URL-es Web Workerben fut. A worker elején a prelude
  letiltja a hálózati API-kat és az `importScripts`-et, így a fordító (és a modell kódja) nem kommunikálhat kifelé.
  `check` műveletnél a C++-kimenet eldobódik, hogy ne utazzon vissza feleslegesen. A Node-on keresztüli futtatás
  szándékosan nincs: ugyanaz a kód fut a Tauri-alkalmazásban és a böngészős buildben.
- **Üzenetek:** a stanc3 kétféle formátumban jelez: a klasszikus „Semantic error in 'string', line L, column C to
  column C2” (0-alapú oszlopok) és az újabb codespan-stílus. Mindkettőt valódi fordítókimenetekből vett mintákon
  tesztelt parser értelmezi. A helyhez nem kötött pedáns figyelmeztetéseket (pl. „parameter X has no priors”) a
  `placeUnlocated` a deklaráció sorára teszi.
- **Adatsablon:** a stanc `info` művelete adja a `data` blokk változóit (típus, dimenziók). Az R-oldali üres érték
  ebből készül (`NA_integer_`, `numeric(0)`, `matrix(…)`, `array(…, dim = …)`). A korlátokat és a pontos típust a
  forrásból vett deklaráció adja megjegyzésként.
- **Feladatok (`jobs.rs`):**
  - Minden művelet egy rövid POSIX `sh`-szkript, amely helyben `sh -c`-vel, távolról a meglévő `RemoteManager.run`-nal
    fut; így a két eset ugyanaz a kód.
  - Az indítás a feladatmappába írja a fájlokat és a `run.sh` burkolót, majd `setsid sh ./run.sh`-val (ennek
    hiányában `nohup`-pal) új munkamenetben indítja. A burkoló:
    - exportálja a `DATAFORGE_JOB_DIR`/`DATAFORGE_JOB_ID` változókat;
    - a kimenetet a `log`-ba irányítja;
    - a végén a kilépési kódot az `exit` fájlba írja.
  - Az állapot fájlokból jön (`exit`, `cancelled`, élő `pid`), ezért bármikor, bármelyik DataForge-példányból
    újraolvasható; nincs memóriabeli állapot, amely az app vagy a kapcsolat elvesztésével elveszne.
  - **Megszakítás:** `TERM` a folyamatcsoportnak (`kill -- -pgid`), rövid várakozás után `KILL`.
  - **Napló:** eltolásalapú olvasás (`tail -c +N | head -c M`); a vágás UTF-8 karakterhatárra igazodik, a maradék a
    következő olvasásban jön.
- **Követés a felületen (`jobsStore.ts`):**
  - csak a futó feladatokat kérdezi le;
  - egy feladatra egyszerre egy lekérdezés fut, és az eredmény csak akkor kerül be, ha az eltolás azóta nem változott
    (így egy szöveg sosem dolgozódik fel kétszer);
  - ha egyik lekérdezés sem ér célba, a panel „kapcsolat megszakadt” állapotot mutat, és a következő sikeres körnél
    magától visszaáll;
  - a figyelt feladatok azonosítója a `localStorage`-ban van, így ami az app bezárása alatt fejeződött be, azt a
    következő indításkor egy értesítés jelzi;
  - munkakönyvtár-váltáskor, ablakfókuszkor és az SSH-kapcsolat helyreállásakor a lista újratöltődik.
- **Folyamatértelmezés (`progress.ts`):** tiszta függvény, darabokban érkező szövegre. A cmdstanr („Chain N
  Iteration: i / T [p%] (Warmup)”) és az rstan („Chain N: Iteration: …”) formátumát is ismeri. A divergenciák és a
  treedepth-találatok a kiírt összesítést veszik át (a cmdstanr kétszer is kiírja). Az R kétsoros hibaüzeneteit
  („Error in f(x) :” + ok) egyben kezeli. A hátralévő idő az utolsó 30 mintavételi pont átlagos sebességéből számolódik.
- **Vendégként** (közös munkában) a feladatok nem érhetők el: a projekt a megosztó gépén van, a feladat pedig ott
  futna. A `hostRouter` ezeket a hívásokat helyi műveletként kezeli, a panel pedig ezt jelzi.

## Teljesítmény

- A fő bundle körülbelül 760 KB (a távoli gépek ablaka külön, igény szerint betöltött darab). A Monaco (kb. 4 MB) csak akkor töltődik be, ha szerkesztőre vagy konzolbemenetre van szükség.
- Az `index.html` inline szkriptje a mentett témához illő háttérrel fest, így nincs fehér villanás.
- A kernelek az első képkocka után, a háttérben indulnak. A felismerés eredménye cache-be kerül, és újraindításkor azonnal elérhető.
- Az indulási időt az `app_info().uptimeMs` méri (`window.__DATAFORGE_STARTUP_MS__`).

## Eltérések az eredeti tervtől (MVP)

- A Rust oldal egyetlen crate (`src-tauri`), modulokra bontva. Külön crate-ekre (`df-host`, `df-kernel`, …)
  a távoli fejlesztés iterációjában válik szét, amikor a `dataforge-host` önálló binárisként fut majd.
- A frontend modulok mappák egyetlen Vite-projektben, `packages/` workspace helyett. A modulhatárokat a fenti
  szerződés és az eseménybusz adja, így a későbbi kiszervezés mechanikus lépés.
- A grafikonok a Jupyter `display_data` útvonalon érkeznek (PNG + SVG + PDF egyszerre), az R oldalon még httpgd nélkül.
  Az átméretezésre való újrarajzolás a httpgd bevezetésével jön.
