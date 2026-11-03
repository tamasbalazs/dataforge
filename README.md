# DataForge

Asztali fejlesztői környezet R-hez és Pythonhoz. Az RStudio adatelemzési kényelmét ötvözi a VS Code rugalmasságával.
Tauri 2 + React + Monaco, a kódfuttatás Jupyter kerneleken keresztül történik.

> **Állapot: 12. iteráció.** Szerkesztő, R/Python konzol, Környezet, Grafikon, adatnézegető, nyelvi szerverek, projektek,
> Fájlok, Csomagok, Súgó, R↔Python Bridge, Quarto/R Markdown előnézet, terminál, Git, hibakereső, reprodukálhatósági
> export, bővítmények és témák, távoli fejlesztés (SSH), közös munka, aláírt telepítők, és most: **Bayesi modellezés
> Stannel** (Stan-szerkesztő élő stanc3-ellenőrzéssel) és **háttérfeladatok**, amelyek túlélik az app bezárását és az
> SSH-kapcsolat megszakadását. A következő lépések az [Ütemterv](#ütemterv) részben vannak.

---

## Indítás egy gombbal

| Rendszer | „Start gomb” |
|---|---|
| **Linux** | `./start.sh` (menübe tehető: `./start.sh --install-shortcut`) |
| **macOS** | dupla kattintás a `start.command` fájlra |
| **Windows** | dupla kattintás a `start.bat` fájlra |

Egy projektmappa közvetlenül is megnyitható: `./start.sh ~/elemzesem` (a VS Code `code .` parancsához hasonlóan).

Az indító ellenőrzi az előfeltételeket és telepíti a függőségeket. Az **első indításkor** lefordítja az alkalmazást, ez néhány perc.
Később azonnal indul, és csak akkor fordít újra, ha a forráskód megváltozott.

### Előfeltételek (egyszer kell telepíteni)

1. **Node.js 20+**: https://nodejs.org. A `pnpm`-et az indító magától bekapcsolja.
2. **Rust**: https://rustup.rs
3. **Rendszerkönyvtárak a Tauri-hoz**
   - Linux (Debian/Ubuntu):
     ```bash
     sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev build-essential
     ```
   - macOS: Xcode Command Line Tools (`xcode-select --install`)
   - Windows: „Desktop development with C++” (Visual Studio Build Tools), a WebView2 a Windows 10/11 része
4. **R és/vagy Python a Jupyter kernellel.** Az alkalmazás első indításkor megkeresi őket.
   Ha valamelyik kernel hiányzik, a pontos telepítési parancsot is megmutatja:
   ```bash
   Rscript -e "install.packages('IRkernel', repos='https://cloud.r-project.org')"
   ```
   ```bash
   python3 -m pip install ipykernel matplotlib pandas
   ```

5. **Nyelvi szerver (ajánlott)** a kiegészítéshez, a hibajelzéshez és a súgóhoz:
   - **Python:** a Pyright-alapú `basedpyright` csomag a saját Node.js-ével együtt települ, ezért magában is működik. A `pyright` és a `pylsp` is felismerésre kerül.
     ```bash
     python3 -m pip install basedpyright
     ```
   - **R:**
     ```bash
     Rscript -e "install.packages('languageserver', repos='https://cloud.r-project.org')"
     ```
   Ha nincs telepítve nyelvi szerver, a státuszsor és a Beállítások panel megmutatja a telepítési parancsot.
6. **Stan (ha Bayesi modelleket illesztesz).** A szerkesztő hibaellenőrzéséhez nem kell semmi: a stanc3 fordító a
   DataForge része. A mintavételhez a projekt gépén (helyben vagy a távoli gépen) a cmdstanr és a CmdStan kell:
   ```bash
   Rscript -e "install.packages('cmdstanr', repos=c('https://stan-dev.r-universe.dev', getOption('repos')))"
   ```
   ```bash
   Rscript -e "cmdstanr::install_cmdstan()"
   ```
   Az rstan és a brms a szokásos módon, CRAN-ról települ (`install.packages(c('rstan', 'brms'))`). Részletek:
   [docs/STAN.md](docs/STAN.md).

### Telepítők

A `pnpm release -- --build --sign` aláírt telepítőket készít a `release/<verzió>/` mappába. Linuxon `.deb`, `.rpm`
és `.AppImage`, macOS-en `.dmg` (Developer ID és notarizáció), Windowson NSIS és `.msi` (Authenticode) készül.
Mellé kerül egy GPG-vel aláírt `SHA256SUMS` is. A letöltést a `scripts/verify-release.sh` (Windowson:
`verify-release.ps1`) ellenőrzi. Részletek: [docs/RELEASING.md](docs/RELEASING.md).

### Fejlesztői mód

```bash
./start.sh --dev
```

Ez gyors újratöltéssel indítja a felületet. Böngészőben, R és Python nélkül is kipróbálható egy szimulált (mock) backenddel:

```bash
pnpm install
```

```bash
pnpm dev
```

Ezután nyisd meg a http://localhost:1420 címet.

---

## Funkciók (1. iteráció)

- **Szerkesztő** (Monaco)
  - több fájl fülekkel, R és Python szintaxis
  - kiegészítés a futó kernelből
  - JetBrains Mono ligatúrákkal
  - a mentetlen, névtelen szkriptek újraindítás után is megmaradnak
- **Kódfuttatás RStudio-módra**
  - `Ctrl+Enter`: kijelölés vagy az aktuális *utasítás* futtatása. A többsoros hívásokat, a pipe-okat és a blokkokat is felismeri, és utána a következő utasításra ugrik.
  - `Ctrl+Shift+Enter`: a teljes fájl futtatása
- **R- és Python-konzol**, egyenrangúan
  - Monaco-alapú bemenet előzményekkel (↑/↓), színezett visszhanggal és ANSI-színes hibákkal
  - futásjelző, futásidő, megszakítás, újraindítás
- **Környezet panel**
  - a változók típus szerint csoportosítva, színkódolt típus, dimenzió, memóriaméret és előnézet
  - szűrés, a megváltozott változók kiemelése
  - a segédkód a kernelben fut, a felhasználó változóterét nem szennyezi
- **Grafikon panel**
  - előzmények bélyegképekkel, nagyítás (görgetés, húzás)
  - exportálás **PNG / SVG / PDF** formátumba
  - a grafikon mérete a panelhez igazodik, a stílusa (háttér, színek, ggplot- és matplotlib-téma) az aktív témához
- **Munkaterület**
  - húzással átrendezhető, dokkolható, lebegtethető és teljes méretre nyitható panelek
  - előre beállított elrendezések: *Adatelemzés*, *Fejlesztés*, *Fókusz*
  - saját elrendezés menthető, a legutóbbi elrendezés visszaáll
- **Adatnézegető** (2. iteráció)
  - **Megnyitás:** dupla kattintás egy táblára a Környezet panelen, a táblázat ikon, vagy `View(df)` R-ben és Pythonban.
  - **Nagy adat:** az adat a kernelben marad; a rendezés, a szűrés és a keresés ott fut, és csak a látható sorok jönnek át,
    100 soros blokkokban, korlátozott gyorsítótárral. 2 millió sornál a rendezés 0,2–0,6 s, a lapozás a gyorsítótárból
    7–30 ms (integrációs teszttel mérve).
  - **Fejléc:** rögzített, színkódolt típusokkal, oszloponkénti **mini hisztogrammal** (számok, dátumok) vagy
    gyakorisági sávokkal (szöveg, faktor), és hiányzóérték-aránnyal.
  - **Rendezés:** kattintás a fejlécre; `Shift`+kattintással több kulcs is megadható.
  - **Oszloponkénti szűrő:** pl. `> 5`, `1 .. 10`, `= Pécs`, `NA`. Az oszlopmenüben statisztika (min., max., átlag,
    különböző értékek) is látszik, és a leggyakoribb értékekre kattintva szűrni lehet.
  - **Teljes billentyűzetes kezelés:** nyilak, `PgUp`/`PgDn`, `Ctrl+Home`/`End`, `Ctrl+C` a cella másolásához.
    Az oszlopok szélessége húzással állítható, dupla kattintásra automatikusan igazodik.
  - **Frissítés:** a nézet magától frissül, ha a változó megváltozik.
- **Nyelvi szerverek (LSP)** (2. iteráció)
  - kiegészítés típusokkal és dokumentációval, súgóablak, paraméter-súgó, ugrás a definícióra,
    dokumentumvázlat (`Ctrl+Shift+O`), formázás, átnevezés (`F2`), hibák és figyelmeztetések aláhúzással
  - a státuszsorban a hibák és figyelmeztetések száma (kattintásra a következőre ugrik), valamint a szerver állapota
  - a konzolban továbbra is a kernel kiegészítése működik, mert az ismeri a futó objektumokat (pl. `df$` oszlopai)
- **Projektek** (3. iteráció)
  - **Megnyitás:** `Ctrl+Alt+O`, a címsor projektmenüjéből (a legutóbbi projektekkel együtt), vagy parancssorból.
  - **Mit jelent a megnyitás:** a kernelek és a nyelvi szerverek a projektmappában indulnak újra. A projekt saját nyitott
    fájljai visszaállnak, és a mentetlen módosításokra rákérdez.
  - **Python:** a projekt `.venv`-je (illetve `venv`) automatikusan kiválasztódik. Egy kattintással **`.venv` hozható létre**
    (uv-vel, ha telepítve van, ipykernellel együtt), és van **`uv sync`** és `requirements.txt`-telepítés is.
  - **R:** **renv**-projektben a kernel a projekt könyvtárával indul. Ehhez az IRkernel helyét a könyvtárlista végére
    fűzi, így a renv elszigeteltsége megmarad. A panelben elérhető a renv pillanatkép, a visszaállítás és a `renv` bekapcsolása.
- **Fájlok panel**
  - lusta faszerkezet, élő frissítés külső változásnál is
  - új fájl vagy mappa, átnevezés helyben (`F2`), áthelyezés a **kukába** (`Delete`, visszaállítható)
  - megjelenítés a fájlkezelőben, helyi menü (`Shift+F10` is), teljes billentyűzetes kezelés
  - **Adatfájl importálása** (CSV, Parquet, Excel, RDS, SPSS/Stata…) dupla kattintásra vagy Enterrel. A konzolban látható,
    **projekt-relatív, reprodukálható kód** fut le (pl. `eladasok <- read.csv("data/eladasok.csv")`), és megnyílik az adatnézegető.
- **Csomagok panel**
  - a telepített csomagok listája verzióval és leírással, keresés
  - a betöltöttség jelölőnégyzettel (R: `library` / `detach`)
  - **telepítés, frissítés, eltávolítás**, minden a konzolban látható kóddal: R-ben `install.packages`, renv-projektben
    `renv::install`; Pythonban `%pip`, illetve `uv pip`, ha a környezetben nincs pip
  - frissíthető csomagok keresése kérésre
- **Súgó panel**
  - R: a csomagok valódi dokumentációja (Rd → HTML), a témához igazítva, működő belső hivatkozásokkal, sandboxolt
    iframe-ben, szkriptfuttatás nélkül
  - Python: aláírás, szakaszokra bontott docstring, modul- és osztálytagok
  - **`F1`** a kurzor alatti szóra (szerkesztőben és konzolban); a konzolban `?téma`, `??keresés`, `help(x)`, `x?`
  - vissza/előre előzmények, keresés
- **R↔Python Bridge** (4. iteráció)
  - R-ből: `py$x` kiolvassa, `py$x <- érték` beírja a Python `x` változóját. Pythonból ugyanez: `r.x` és `r.x = érték`.
    A nem érvényes nevekhez: `py[["név"]]`, `r["my.data"]`.
  - Típushű átvitel: adatkeret ↔ pandas DataFrame, faktor ↔ category, `Date` / `POSIXct` ↔ datetime (időzónával),
    NA ↔ NaN / `pd.NA` / `None`, egész ↔ nullable `Int64`, sornevek ↔ index, mátrix ↔ 2D numpy tömb, lista ↔ dict.
  - Gyors: **1 millió soros adatkeret R-ből Pythonba kb. 0,35 s** alatt. Az adat bináris oszlopfájlokban megy át,
    nem JSON-ban és nem a vágólapon.
  - A Környezet panelben minden változónál ott a **„Másolás ide: Python / R”** gomb. Ez látható, reprodukálható sort futtat
    a másik konzolban (`eladasok = r.eladasok`).
  - Pandas nélkül is működik a skalárokra, vektorokra és listákra; adatkeretnél érthető üzenet mondja meg, mit kell telepíteni.
  - A Pyright nem jelzi hibának a `r` / `View` neveket, mert ezeket a DataForge adja a kernelekhez.
- **Quarto / R Markdown** (4. iteráció)
  - **Élő előnézet** (`Ctrl+Shift+K`): a dokumentum önálló HTML-lé renderelődik, és a szerkesztő mellett, egy Előnézet panelen jelenik meg.
    **Mentéskor újrarenderel**, és a görgetési pozíció megmarad. A `.qmd` fájlokat a Quarto, az `.Rmd` fájlokat az
    `rmarkdown::render` rendereli (az RStudióhoz hasonlóan), a projekt értelmezőivel (`QUARTO_PYTHON`, `QUARTO_R`, `RETICULATE_PYTHON`).
  - A kimenet a rendszer ideiglenes mappájába kerül, a forrásmappába nem ír semmit.
  - Hiba esetén megmarad az utolsó jó előnézet, és a napló a **kiemelt hibasorral** nyílik meg (pl. YAML-hiba sorszámmal).
  - **Chunkok futtatása:** `Ctrl+Enter` a chunkon belüli utasítást, `Ctrl+Shift+Enter` az egész chunkot futtatja, mindig
    a chunk nyelvén (R vagy Python). A chunkok fölött **„▶ R-chunk futtatása” / „Összes fenti futtatása”** gomb van.
    Az összes chunk futtatása (`Ctrl+Alt+R`) sorban halad, a nyelvek között is megvárja az előzőt, és hibánál megáll.
- **Terminál** (5. iteráció)
  - Valódi shell (bash/zsh, Windowson PowerShell) pszeudoterminálon, a projektmappában indul. Ha van projekt-venv,
    az kerül a PATH elejére, így a `python` és a `pip` a projekté.
  - Több munkamenet fülekkel. A görgetési előzmény fül- és elrendezésváltáskor is megmarad. A fülcímet a shell állítja.
  - 256 szín / truecolor, a témához igazított ANSI-paletta, kattintható linkek, másolás és beillesztés (`Ctrl+Shift+C` / `Ctrl+Shift+V`).
  - **`` Ctrl+` ``** a terminálra ugrik, újra megnyomva vissza a szerkesztőre. **`` Ctrl+Shift+` ``** új terminált nyit.
  - A terminálban a shell kapja meg a `Ctrl+C`, `Ctrl+R`, `Ctrl+W`… billentyűket. Az alkalmazás csak a navigációs
    parancsokat (`Ctrl+Shift+…`, `Alt+…`, `Ctrl+Alt+…`) veszi el.
- **Git** (5. iteráció)
  - **Változások:**
    - Merge-konfliktusok, stage-elt és módosított fájlok, fájlonként vagy egyszerre stage-elés, visszavonás, elvetés
      (az új fájlok a kukába kerülnek).
    - Kattintásra **diff** nyílik a Monaco diff-nézetében (egymás mellett vagy soron belül, +/− statisztikával).
  - **Commit** `Ctrl+Enter`-rel, utolsó commit módosításával (amend). Ha semmi nincs stage-elve, felajánlja, hogy mindent stage-el.
  - **Ágak:** váltás (távoli ágról követő ággal együtt) és új ág létrehozása. **Távoli tároló:** szinkronizálás
    (pull + push), pull, push, fetch, valamint az ág közzététele (`push -u`), ha még nincs upstream.
  - **Előzmények:** commitlista ág- és címkejelölőkkel, kereséssel. Egy commitot kibontva látszanak a fájljai, és mindegyik
    diffje megnyitható.
  - **Merge-konfliktusok:**
    - A szerkesztőben színezett blokkok és „Jelenlegi elfogadása | Bejövő elfogadása | Mindkettő” gombok jelennek meg,
      a választás visszavonható.
    - Az utolsó konfliktus után a felület felajánlja: „Mentés és megoldottnak jelölés”. A merge megszakítható.
  - A panel magától frissül: fájlváltozáskor, ablakfókuszkor, és akkor is, ha a terminálból adsz ki git-parancsot
    (a `.git` állapotfájljait is figyeli).
  - Az állapotsoron látszik az ág, a módosítás jelzése, valamint a pusholandó és pullolandó commitok száma.
- **Hibakereső** (6. iteráció)
  - **Töréspontok:**
    - Kattints a sorszám bal oldalára, vagy nyomd meg az `F9`-et egy mentett `.R` vagy `.py` fájlban.
    - Szerkesztés közben a töréspontok a sorukkal együtt mozognak, és újraindítás után is megmaradnak.
  - **`F5`** hibakeresés alatt futtatja az aktuális fájlt, a konzol munkamenetében:
    - Pythonban `debugfile("…")`, R-ben `debugSource("…")` (az RStudióval azonos néven).
    - Megálláskor kiemelődik a sor, és a Hibakereső panel magától előjön.
  - **Léptetés:** `F10` átlépés, `F11` belépés, `Shift+F11` kilépés, `F5` folytatás, `Shift+F5` leállítás
    (a munkamenet és a változók megmaradnak).
  - **Panel:**
    - kibontható változófa (adatkeretek, listák, dict-ek), hívási verem keretválasztással;
    - figyelt kifejezések, amelyek minden megálláskor frissülnek;
    - töréspontlista, valamint kiértékelés a kiválasztott keretben, előzményekkel (↑/↓).
  - **Közös munkamenet:** a hibakereső ugyanazokat a változókat látja, amelyekkel a konzolban dolgozol. A töréspontok a
    konzolból hívott függvényeknél is megállnak, ha a függvényt hibakeresés alatt futtatott fájl definiálta.
  - **Python:** valódi DAP (debugpy) a Jupyter debug-protokollon keresztül, a kernelben. Nem kell külön folyamat
    vagy beállítás, csak ipykernel 6+ és debugpy.
  - **R:** mivel R-hez nincs DAP-szerver, a DataForge saját, DAP-szerű hibakeresőt használ. A futtatott szkript `{` blokkjait
    és függvénytörzseit lépéspontokkal instrumentálja. A függvények kiírása az eredeti forrást mutatja.
- **Reprodukálhatóság** (7. iteráció; `Ctrl+Alt+E` vagy a címsor projektmenüje)
  - **Jelentés:** a DataForge átnézi a projekt kódját (R, Python, Quarto/R Markdown chunkok, notebookok), és megmutatja:
    - a használt csomagokat, pontos verzióval és a teljes függőségi lezárttal; ezt a futó kernelek adják, nem becslés;
    - a hivatkozott adatfájlokat;
    - a git-állapotot;
    - a megállapításokat, kattintásra a kód megfelelő sorára ugorva: `setwd()`/`os.chdir()`, abszolút útvonal,
      véletlenszám seed nélkül, hiányzó csomag vagy fájl, a szkriptből telepített csomag, GitHubról telepített csomag,
      nem commitolt módosítás.
  - **Export** ZIP-be vagy mappába:
    - `project/`: a kód, és ha kéred, az adatok;
    - `environment/R/renv.lock`: CRAN- és GitHub-forrással, `renv::restore()`-ral visszaállítható; mellette `sessionInfo.txt`;
    - `environment/python/requirements.txt`: a használt csomagok és függőségeik pontos verzióval; mellette `pip-freeze.txt`;
    - `checksums.sha256`: SHA-256 minden fájlhoz;
    - `manifest.json`: gépi összefoglaló, git-committal;
    - `REPRODUKALAS.md`: útmutató a felület nyelvén;
    - opcionálisan egy `Dockerfile` (`rocker/r-ver:<R-verzió>`).
  - **`reproduce.sh`:**
    - ellenőrzi a fájlokat, külön R-könyvtárba visszaállítja az R-csomagokat, venv-be telepíti a Python-csomagokat;
    - a megadott sorrendben lefuttatja a szkripteket;
    - figyelmeztet, ha az R- vagy Python-verzió eltér az eredetitől;
    - kapcsolók: `--check-only`, `--setup-only`, `--run-only`.
- **Bővítmények** (8. iteráció; `Ctrl+Shift+X`; útmutató: [docs/EXTENSIONS.md](docs/EXTENSIONS.md))
  - **Telepítés:** `.dfext` csomagból, fejlesztéshez közvetlenül mappából. Engedélyezés, kikapcsolás, eltávolítás és
    újratöltés a Bővítmények panelen.
  - **Biztonság:**
    - A bővítménykód saját **Web Workerben** fut, DOM és Tauri-hozzáférés nélkül.
    - A projekthez, a kernelekhez és a szerkesztőhöz csak deklarált **jogosultságokkal** fér hozzá (`editor`, `kernel`,
      `workspace`, `network`), és ezeket telepítéskor a felhasználó hagyja jóvá. Hálózat csak `network` jogosultsággal érhető el.
  - **Mit adhat hozzá egy bővítmény:**
    - parancsokat (a palettában, billentyűvel; a beépítetteket nem írhatja felül);
    - saját paneleket (sandboxolt iframe, a téma színeivel, kétirányú üzenetekkel);
    - VS Code-formátumú snippeteket és színtémákat.
  - **Példa:** az `examples/extensions/data-summary` (*Adat-összefoglaló*) a kijelölt változó `summary()`/`describe()`
    eredményét mutatja egy panelen, és a kódot egy kattintással a szkriptbe teszi; snippeteket és egy témát is hoz.
    Csomagolás: `pnpm pack:ext examples/extensions/data-summary`.
- **Témák és témamegosztás** (8. iteráció; Beállítások → Megjelenés)
  - Saját színtémák listája; az aktív téma az egész felületre érvényes: panelek, Monaco, diff, terminál-ANSI, grafikonok,
    bővítménypanelek, és a fehér villanás nélküli indulás is.
  - **Importálás:** DataForge-téma (`.dftheme.json`) vagy **VS Code-színtéma** (JSONC is): a szerkesztő-, oldalsáv-,
    kiemelés-, állapot- és szintaxisszínek leképezése a DataForge tokenekre.
  - Import után minden színpár **WCAG AA** szintre igazodik, és a DataForge jelzi, hány színt módosított.
  - **Exportálás:** az aktuális téma teljes palettája megosztható `.dftheme.json` fájlként.
- **Távoli fejlesztés SSH-n és konténerben** (9. iteráció; `Ctrl+Alt+K`; útmutató: [docs/REMOTE.md](docs/REMOTE.md))
  - **Mentett gépek:** név, gép (vagy `~/.ssh/config`-álnév), felhasználó, port, kulcsfájl, kezdőmappa. A rendszer
    `ssh`-kliensét használja, így az ssh-agent, a kulcsok, a jump hostok és a `known_hosts` is érvényes. Jelszót a
    DataForge nem tárol.
  - **Távoli mappa megnyitása projektként:** mappaböngészővel; a Fájlok panel, a szerkesztő, a Git panel, a terminál és
    **mindkét kernel a távoli gépen** fut. A Környezet panel, az adatnézegető, a grafikonok, a súgó, a csomagok és a
    Python-hibakereső ugyanúgy működik, mint helyben.
  - **Kernelek:** a gépen futnak, a Jupyter-portok SSH-alagúton jönnek át (csak a távoli loopbackre kötve). A
    megszakítás a távoli folyamatnak küld jelet. Ha az alkalmazás kilép vagy összeomlik, egy őrfolyamat a gépen is
    leállítja a kernelt.
  - **Reprodukálhatósági export** távoli projektből is: a fájllista és az SHA-256 a gépen készül, a csomag helyben.
  - **Konténer:** az [`examples/remote-container`](examples/remote-container) egy R + Python + sshd képet indít, amely
    csak a `127.0.0.1`-en figyel, és csak a megadott kulccsal enged be.
  - A státuszsor bal szélén az **SSH-jelző** mutatja, hol van a projekt; a kapcsolat megszakadásakor egy kattintással
    újracsatlakozhatsz.
- **Közös munka valós időben** (10. iteráció; `Ctrl+Alt+L`; útmutató: [docs/COLLABORATION.md](docs/COLLABORATION.md))
  - **Megosztás meghívóval:** a projekt a megosztó gépén marad; a vendégek a saját DataForge-ukban csatlakoznak.
    Alapból csak a helyi gépről érhető el (másik gépről SSH-alagúton), választhatóan a helyi hálózaton is.
  - **Közös szerkesztés** CRDT-vel (Yjs): ütközés nélkül, élő, névvel jelölt kurzorokkal és kijelölésekkel. A vendég
    mentése a megosztó lemezére ír.
  - **Közös kernelek:** a vendég konzolja, Környezet panelje, adatnézegetője és grafikonjai a megosztó kerneleit
    mutatják. A futtatott kód mellett látszik, ki futtatta.
  - **Szerepek:** néző (csak olvas), szerkesztő, futtató. Minden kérést a megosztó ellenőriz; személyenként
    módosítható, bárki eltávolítható.
  - **Résztvevők panel:** ki hol jár, követés (a szerkesztő a másik ember fájljára és sorára ugrik), csevegés,
    olvasatlan-jelző a státuszsoron.
- **Bayesi modellezés Stannel** (12. iteráció; útmutató: [docs/STAN.md](docs/STAN.md))
  - **Stan-szerkesztő** (`.stan`, `.stanfunctions`; új modell: paletta → „Új Stan-modell”):
    - szintaxiskiemelés;
    - **élő hibaellenőrzés a hivatalos stanc3 fordítóval** (v2.36.0), gépelés közben, a fájl mentése nélkül;
    - a fordító üzenete a hiba helyén jelenik meg (`F8`: következő hiba);
    - állapotjelző az eszköztáron: „Lefordítható”, vagy a hibák és figyelmeztetések száma;
    - **pedáns mód** (`--warn-pedantic`): pl. prior nélküli paraméter, nem használt változó.
  - **Kiegészítés és súgó:**
    - a `~` után az eloszlások a paramétereikkel (`student_t(nu, mu, sigma)`);
    - a `_lpdf/_lcdf/_rng` változatok, a függvények, a típusok;
    - a modell saját változói;
    - súgó a kurzor alatti eloszláshoz vagy függvényhez.
  - **Formázás** a stanc formázójával (`Shift+Alt+F` vagy eszköztár-gomb).
  - **R-adatsablon:** a modell `data` blokkjából egy kitöltendő `stan_data <- list(...)` kerül a vágólapra, típusmegjegyzésekkel
    és a dimenzióknak megfelelő üres értékekkel.
  - **Fordítás cmdstanr-rel** a konzolban: `<név>_mod <- cmdstanr::cmdstan_model("…")`.
  - **`{stan}` chunkok** Quarto- és R Markdown-dokumentumban, `output.var`-ral:
    - ha a dokumentum meghívja a `cmdstanr::register_knitr_engine()`-t, cmdstanr-rel fordul;
    - különben `rstan::stan_model()`-lel.
  - **Stan-kód megnyitása R-objektumból:** a Környezet panelen a brms- (`brmsfit`), rstan- (`stanfit`, `stanmodel`) és
    cmdstanr-objektumok (`CmdStanModel`) mellett egy gomb a generált/használt Stan-kódot új szerkesztőfülön nyitja meg.
- **Háttérfeladatok** (12. iteráció; `Ctrl+Alt+J`)
  - **Mi futhat háttérben?**
    - **Stan-mintavétel** cmdstanr-rel vagy rstannal, közvetlenül a modellfájl eszköztáráról. A beállítások: láncok,
      párhuzamos láncok, bemelegítés, mintavétel, seed, `adapt_delta`, `max_treedepth`, kijelzési lépésköz.
    - **Bármely R-szkript**, pl. egy órákig futó brms-modell. Kérésre a szkript végén minden létrehozott objektum mentődik.
  - **Külön R-folyamatban futnak, a projekt gépén** (helyben vagy a távoli SSH-gépen), a konzoltól függetlenül, így a
    konzol közben szabad.
  - **Túlélik az app bezárását és az SSH-kapcsolat megszakadását.** A feladat a gépen egy saját munkamenetben fut, a
    kimenete egy naplófájlba megy. Az app újraindításakor vagy újracsatlakozáskor a DataForge automatikusan újra
    követi a futó feladatokat. Ha egy feladat közben befejeződött, egy értesítés jelzi.
  - **Feladatok panel:**
    - folyamatjelző és hátralévő idő;
    - **láncokra bontott állapot** (bemelegítés / mintavétel, futásidő);
    - a **divergens átmenetek** és a `max_treedepth` elérésének száma, javaslattal (pl. `adapt_delta` növelése,
      nem-centrált paraméterezés);
    - R-hibák kiemelve;
    - a teljes napló;
    - megszakítás (az egész folyamatcsoportot leállítja), törlés.
    - Ha a gép nem érhető el, a panel jelzi, hogy a feladatok tovább futnak, és a követés automatikusan folytatódik.
  - **Eredmények betöltése egy kattintással** a konzolba: Stan-mintavételnél az illesztés (`fit`) a megadott néven
    (`fit.rds`), szkriptnél a mentett objektumok.
  - A státuszsor mutatja a futó feladatok számát és együttes előrehaladását.
- **Akadálymentesség** (csiszolás)
  - **Automatikus audit:** az `axe-core` 48 állapotban (bemutató, munkaterület, minden panel, Stan-szerkesztő, feladatok, paletta, ablakok)
    ellenőrzi a WCAG 2.1 A/AA szabályokat, világos és sötét témában is. Jelenleg nincs eltérés.
  - **Billentyűzet:**
    - minden vezérlő elérhető Tabbal, és látható fókuszjelzést kap;
    - az ablakok a tartalmuk első mezőjén nyílnak, és csapdába zárják a fókuszt (`Esc`-re visszaadják);
    - a fókuszban lévő fül `Delete`-tel zárható (szerkesztő, panelek, terminál);
    - a szerkesztőből a `Ctrl+M` engedi tovább a Tabot (mint a VS Code-ban), vagy az `Alt+1…0` vált panelt.
  - **Képernyőolvasó:** a panelfülek a felület nyelvén olvasódnak fel, és a „nem mentett” állapot is elhangzik.
- **Konzol:** a folyamatjelzők (tqdm, pip, uv) a végső állapotukban jelennek meg, nem vezérlőkódok halmazaként.
- **Parancspaletta** (`Ctrl+Shift+P`) fuzzy kereséssel, minden művelet parancsként és billentyűvel is elérhető
- **Megjelenés**
  - világos, sötét és rendszerkövető téma
  - felületnagyítás (`Ctrl +/-/0`), állítható szerkesztő-betűméret
  - magyar és angol felület
- **Első indítási bemutató**: nyelv, téma, R/Python felismerése, elrendezés kiválasztása

### Billentyűparancsok

| Művelet | Billentyű |
|---|---|
| Parancspaletta | `Ctrl+Shift+P` |
| Sor / kijelölés futtatása | `Ctrl+Enter` |
| Fájl futtatása (qmd/Rmd-ben: az aktuális chunk) | `Ctrl+Shift+Enter` |
| Összes chunk futtatása | `Ctrl+Alt+R` |
| Quarto / R Markdown előnézet | `Ctrl+Shift+K` |
| Terminál ↔ szerkesztő / új terminál | ``Ctrl+` `` / ``Ctrl+Shift+` `` |
| Git panel | `Ctrl+Shift+G` |
| Reprodukálhatósági jelentés és export | `Ctrl+Alt+E` |
| Bővítmények | `Ctrl+Shift+X` |
| Hibakeresés indítása / folytatás, leállítás | `F5` / `Shift+F5` |
| Töréspont be/ki | `F9` |
| Átlépés / belépés / kilépés | `F10` / `F11` / `Shift+F11` |
| Commit (a Git panel üzenetmezőjében) | `Ctrl+Enter` |
| Új R / Python szkript | `Ctrl+Alt+N` / `Ctrl+Alt+Shift+N` |
| Megnyitás / mentés | `Ctrl+O` / `Ctrl+S` |
| Panelek: szerkesztő, konzol, környezet, grafikonok, fájlok, csomagok, súgó, Git, terminál, hibakereső | `Alt+1` … `Alt+9`, `Alt+0` |
| Projekt megnyitása | `Ctrl+Alt+O` |
| Távoli gép (SSH) | `Ctrl+Alt+K` |
| Projekt megosztása (közös munka) | `Ctrl+Alt+L` |
| Háttérfeladatok panel | `Ctrl+Alt+J` |
| Következő hiba (pl. Stan-fordító üzenete) | `F8` |
| Dokumentum formázása (Stan: stanc) | `Shift+Alt+F` |
| Súgó a kurzor alatti szóhoz | `F1` |
| Elrendezések | `Ctrl+Alt+1` … `Ctrl+Alt+3` |
| Futó kód megszakítása | `Ctrl+Alt+C` |
| Téma váltása | `Ctrl+Alt+T` |
| Felületnagyítás | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |

macOS-en a `Ctrl` helyett `⌘` használandó.

---

## Tesztek

```bash
pnpm test
```

A fenti parancs a frontend egységtesztjeit futtatja (Vitest). Ezek lefedik:
- a design tokeneket és a WCAG AA kontrasztot,
- a parancsokat és a billentyűket,
- az utasításhatár-felismerést,
- az ANSI-feldolgozót,
- a környezeti segédfüggvényeket,
- a magyar és angol fordítások egyezését,
- a qmd/Rmd chunkfelismerést, a render-parancs összeállítását és a hibanapló összefoglalását,
- a Bridge-kódsorok generálását (névátalakítással),
- a git-kimenetek értelmezését valódi git-kimenetmintákon (porcelain v2 status, log, ágak, `--name-status`),
  a konfliktusblokkok felismerését és feloldását,
- a terminálbillentyűk továbbengedését és a toastok időzítését,
- a töréspontkezelést (fájltípus, rendezés, átkapcsolás, törlés),
- a reprodukálhatósági elemzést (csomag-, import- és adathivatkozás-felismerés, kockázatok, Quarto-chunkok, notebookok,
  útvonalfeloldás) és a csomagkészítést (renv.lock, requirements.txt, reproduce.sh, Dockerfile, manifest, útmutató),
- a bővítmény-manifest ellenőrzését, a jogosultsági szabályokat (API-hívások, deklarált parancsok/panelek, útvonalak),
  a verziótartomány-kezelést és a VS Code-snippetek beolvasását,
- a témákat: VS Code-import (JSONC, scope-illesztés, átlátszó színek), WCAG AA-javítás, saját formátum oda-vissza,
- a távoli útvonalakat (`ssh://`, kernel- és munkaterület-út közti átalakítás) és a gépprofilokat (ellenőrzés,
  `user@gép:port` felbontása, azonosítók, egyszeri kapcsolódás, hibák rögzítése, a gép értelmezőinek választása),
- a közös munkát egy megosztóval és két vendéggel, memóriabeli továbbítón:
  - a meghívó formátumát és a szerepszabályokat;
  - a dokumentumok összefésülését három irányból;
  - a nézők módosításainak eldobását és a mentést a megosztón át;
  - az RPC-jogosultságokat (futtatás, segédfüggvények, útvonalak, nyelv);
  - a csevegést, a jelenlétet, a kernelkimenetet, az eltávolítást és a munkamenet végét.
- a Stan-támogatást, **a valódi stanc3 üzeneteiből vett mintákon**:
  - a hibaüzenetek helyének és szövegének értelmezését (régi és új formátum), a helyhez nem kötött figyelmeztetések
    (pl. prior nélküli paraméter) elhelyezését;
  - az R-adatsablont (típusok és dimenziók szerinti üres értékek);
  - az eloszlás- és függvénykatalógust;
  - a `{stan}` chunkokat (`output.var`, cmdstanr vagy rstan);
  - a beágyazott stanc.js ellenőrzőösszegét;
- a háttérfeladatokat:
  - a cmdstanr- és rstan-kimenet folyamatértelmezését darabokban érkező sorokkal, a divergenciákat, a többsoros R-hibákat;
  - a hátralévő idő becslését;
  - a feladatszkripteket és a beállítások ellenőrzését;
  - az eredmények betöltését és az adatátadást (névellenőrzéssel).

Opcionális teszt valódi eszközökkel (R, Python, git), amely egy valódi projektből csomagot készít:

```bash
DF_REAL_BUNDLE=/út/a/projekthez DF_OUT=/üres/mappa pnpm vitest run src/repro/realBundle.test.ts
```

```bash
pnpm typecheck
```

```bash
cd src-tauri
```

```bash
cargo test
```

A `cargo test` a Rust egységteszteket futtatja (wire protocol és HMAC, felismerés, nyelvi kódgenerálás, LSP-keretezés).
Az **integrációs tesztek** valódi R- és Python-kernelt indítanak, ha telepítve vannak:
- kódfuttatás, változólista, grafikonok (PNG/SVG/PDF), hibák;
- annak ellenőrzése, hogy a belső hívások nem szivárognak-e a konzolba;
- adatnézegető **2 millió soron**: lapozás, rendezés, szűrés, keresés, statisztika, `View()`, időkorláttal;
- valódi Python nyelvi szerver: inicializálás, diagnosztika, kiegészítés;
- csomaglista és súgó R-ben és Pythonban;
- **R-kernel indulása renv-projektben** (valódi `renv::init`);
- fájlműveletek és változásfigyelés, projektvizsgálat;
- **R↔Python Bridge** két valódi kernellel: típushűség, írás mindkét irányba, hibajelzés, 1 millió sor időkorláttal;
- **terminál** valódi shell-lel: UTF-8, környezeti változók, venv a PATH elején, átméretezés, kilépési kód;
- a git-futtató engedélylistája és futtatása valódi repóban;
- a reprodukálhatósági fájllista (környezetek és cache-ek nélkül), a SHA-256 és a ZIP-, illetve mappaírás
  (futtathatósági jog, útvonalvédelem);
- a `.dfext`-telepítő: frissítés a helyén, eltávolítás, valamint zip-slip, hibás azonosító és hiányzó manifest elutasítása;
- **Python-hibakeresés** valódi ipykernel + debugpy alatt: töréspont, verem, lokális változók, kiértékelés, léptetés, folytatás;
- **R-hibakeresés** valódi R-kernellel: töréspont függvényben, verem (`f` → szkript), változók és kibontható adatkeret,
  kiértékelés, átlépés, kilépés, folytatás, valamint leállítás úgy, hogy a kernel életben marad.

**Közös munka:** a `tests/collab.rs` a valódi WebSocket-továbbítót teszteli:
- a hibás és a második gazda-kód elutasítását;
- hogy vendég csak a megosztónak üzenhet;
- a címzett és a „mindenki, kivéve” küldést;
- az eltávolítást, a kilépést és a munkamenet végét;
- a 3 MB-os üzeneteket.

**Háttérfeladatok:** a `tests/jobs.rs` valódi folyamatokkal ellenőrzi:
- a napló folyamatos olvasását, a sikeres és a hibás befejezést, a megszakítást;
- hogy a feladat saját munkamenetben fut (a DataForge kilépése nem állítja le);
- a listázást és a törlést;
- **valódi cmdstanr-mintavételt** (ha a cmdstanr és a CmdStan telepítve van): láncok, `fit.rds`.

A tesztek a `DATAFORGE_JOBS_ROOT` ideiglenes mappáját használják, a valódi `~/.dataforge/jobs` érintetlen marad.

**Távoli fejlesztés** (valódi SSH-szerver kell hozzá, ezért alapból kimarad):

```bash
DF_SSH_TEST=felhasznalo@gep:port,/ut/a/kulcshoz cargo test --test remote --test jobs
```

Ez ellenőrzi:
- a fájlműveleteket (ékezetes nevek, felülírás- és útvonalvédelem), a projektvizsgálatot és a gitet (engedélylista);
- a reprodukálhatósági fájllistát, az SHA-256-ot és a letöltést;
- a **távoli R- és Python-kernelt**: futtatás, munkakönyvtár, segédhívások (Környezet panel), megszakítás;
- hogy leállítás után nem marad kernelfolyamat vagy kapcsolatfájl, és hogy az alkalmazás hirtelen kilépésekor az
  őrfolyamat leállítja a kernelt;
- a hitelesítési hibák érthető üzenetét;
- hogy egy **távoli háttérfeladat a kapcsolat teljes bontása alatt is tovább fut**, és újracsatlakozás után a
  teljes naplója olvasható.

> Megjegyzés: a `cargo test --release` a `target/release/dataforge` binárist fejlesztői módban fordítja újra. Utána
> a `pnpm tauri build` (vagy a start gomb) állítja vissza az önálló alkalmazást.

### End-to-end füstpróba

Böngészőben, a mock backenddel fut. A Chromiumot egyszer telepíteni kell: `npx playwright install chromium`.

```bash
pnpm build
```

```bash
pnpm e2e
```

Akadálymentesség:

```bash
pnpm a11y
```

Ez az axe-core auditot (48 állapot, két téma) és a billentyűzetes tesztet futtatja. Utóbbi ellenőrzi:
- a Tab-bejárást és a látható fókuszt;
- hogy a fókusz nem vész el;
- a fókuszcsapdát és a fókusz visszaadását;
- a `Delete`-tel zárható füleket;
- a palettát billentyűzettel;
- a lefordított fülneveket.

(A `pnpm e2e` három tesztet futtat: a füstpróbát, az `e2e/collab.mjs`-t, amely két felhasználót szimulál egy
böngészőben, és az `e2e/stan.mjs`-t.)

Az `e2e/stan.mjs` ellenőrzi:
- hogy a stanc3 a sandboxolt workerben lefordítja az új modellt, és a kiemelést;
- az elgépelt eloszlásnév hibajelzését és a fordító magyarázatát (`F8`);
- a pedáns módot (prior nélküli paraméter);
- a `~` utáni kiegészítést paraméterekkel;
- a stanc-formázást és az R-adatsablont;
- a mintavételi ablak hibás beállításainak magyarázatát;
- a láncokra bontott folyamatot, a státuszsort, a befejezési értesítést, a divergencia-tanácsot és a betöltést;
- hogy a panel indítógombja követi a szerkesztő aktív fülét.

Ellenőrzi:
- az első indítási bemutató billentyűzetes kezelését,
- a `Ctrl+Enter` futtatást,
- a változók és a grafikonok megjelenését,
- az exportmenüt,
- a parancspalettát,
- a téma-, az elrendezés- és a nyelvváltást,
- a qmd-chunkok futtatását a saját nyelvükön, a CodeLens-gombokat, a `Ctrl+Shift+K` előnézetet (két dokumentummal),
- a Környezet panel „Másolás ide” Bridge-gombját,
- a Git-folyamatot: változások, diff, stage-elés, commit `Ctrl+Enter`-rel, állapotsor, előzmények,
- a terminált (parancs a projektmappában; a `Ctrl+W` a shellnek megy, nem zárja be az ablakot),
- a konfliktusfeloldást a CodeLens-gombokkal,
- a hibakeresőt: `F9` töréspont, `F5` megállás a sorban, változók kibontása, kiértékelés, folytatás a végéig,
- a reprodukálhatósági jelentést (R-csomagok, git-commit, adatfájlok, ellenőrzőösszegek) és az exportot,
- a bővítményeket: jóváhagyás, aktiválás, parancs → kernel → panel → szerkesztő kör, a bővítmény témája,
- egy **sandbox-próbát**: egy fejlesztői bővítmény hálózati, jogosulatlan API-, IPC- és DOM-hozzáférési kísérleteit,
- a **közös munkát** két ablakban (megosztó és vendég):
  - meghívó és csatlakozás, a hibás meghívó elutasítása;
  - közös szerkesztés mindkét irányból, a másik ember kurzora névvel;
  - mentés a megosztón át, csevegés;
  - szerepek: a szerkesztő nem futtathat, a futtató kódja a megosztó konzoljában a nevével jelenik meg, a néző csak olvashat;
  - követés, és hogy a munkamenet vége visszaviszi a vendéget a saját projektjébe;
- a **távoli fejlesztést** (mock SSH-gép): új gép felvétele, kapcsolódás, értelmezők, mappaböngésző, megnyitás, SSH-jelző,
  távoli fájlok a Fájlok panelen és a szerkesztőben, valamint a hitelesítési hiba megjelenítése.

### Mért indulási idő

A release buildben az ablak **kb. 0,4 másodperc** alatt jelenik meg, már kirajzolt felülettel.
A mérés Linuxon, Xvfb alatt, szoftveres rendereléssel készült. Fehér villanás nincs, mert az ablak rejtve indul,
és az első kirajzolás után, a téma színével jelenik meg. A Monaco és a kernelek ezután, a háttérben töltődnek be.

## Felépítés

```
src/                    React felület
  core/                 host-réteg (Tauri / mock), eseménybusz, parancsok, beállítások, i18n, téma
  design/               design tokenek (egyetlen forrás) + globális stílusok
  kernels/              kernelszolgáltatás (életciklus, futtatás, sorrend)
  panels/<név>/         önálló panelmodulok: editor, console, environment, plots, data, files, packages, help, preview, git (+diff), terminal
  bridge/               R↔Python átadás a felületről (reprodukálható kódsorok)
  git/                  git-kimenetek értelmezése (tesztelt) és a Git-állapot/műveletek tárolója
  debug/                hibakereső: töréspontok, munkamenet, Python- és R-adapter
  repro/                reprodukálhatóság: kódelemzés (scan), csomagkészítés (bundle), jelentés és export (store)
  extensions/           bővítmény-host: manifest és jogosultságok, worker-prelude, RPC, snippetek
  themes/               témamodell (VS Code-import, WCAG-javítás, formátum) és témakezelés
  remote/               távoli gépek: profilok, kapcsolatok, SSH-ablak mappaböngészővel
  collab/               közös munka: protokoll és szerepek, HostSession/GuestSession, Monaco↔Yjs kötés, kurzorok, ablak
  stan/                 Stan: katalógus, stanc3-worker (ellenőrzés, formázás, info), Monaco-nyelv, eszköztár, műveletek
  jobs/                 háttérfeladatok: folyamatértelmezés, R-szkriptek, tároló (követés, újracsatolás), indítóablak
  panels/jobs/          Feladatok panel
public/vendor/stanc/    a hivatalos stanc3 (v2.36.0) JavaScript-fordító, ellenőrzőösszeggel és forrásmegjelöléssel
  core/hostRouter.ts    vendégként a kernelhívások és a collab:// fájlok a munkamenetbe mennek
examples/extensions/    példabővítmény (Adat-összefoglaló)
examples/remote-container/  R + Python + sshd konténer távoli fejlesztéshez
scripts/release.mjs     telepítők összegyűjtése, SHA256SUMS, manifest, GPG-aláírás
scripts/verify-release.sh / .ps1  letöltött kiadás ellenőrzése (aláírás, ellenőrzőösszeg, Authenticode)
.github/workflows/      CI (tesztek, e2e, a11y) és kiadás (aláírt telepítők három platformra)
scripts/pack-extension.mjs  .dfext csomagoló
  lsp/                  LSP-kliens (JSON-RPC, Monaco-adapterek, dokumentumszinkron)
  project/              projektkezelés (megnyitás, váltás, értelmezőválasztás)
  workbench/            dockview-alapú munkaterület, elrendezések, panelregiszter
  app/                  címsor, státuszsor, paletta, beállítások, bemutató
  locales/              hu.json, en.json
src-tauri/              Rust host
  src/kernel/           Jupyter wire protocol, kernelindítás és -kezelés
  src/envdetect.rs      R/Python felismerés
  src/lsp.rs            nyelvi szerverek felismerése, indítása, stdio-keretezés
  src/fsops.rs          fájlműveletek (lista, létrehozás, átnevezés, kuka) + projektfigyelő
  src/project.rs        projektvizsgálat (renv, venv, uv, .Rproj) és venv-létrehozás
  src/procs.rs          háttérfolyamatok (uv, venv, render) streamelt kimenettel
  src/bridge.rs         R↔Python bridge: helyi HTTP-végpont tokennel, a kernelek közti adatcsere vezérlése
  src/pty.rs            terminál-munkamenetek (pszeudoterminál, streamelt kimenet)
  src/git.rs            nem interaktív git-futtató engedélyezett alparancsokkal
  src/repro.rs          projektfájlok listája, SHA-256, ZIP- és mappaírás
  src/ext.rs            .dfext-telepítés (biztonságos kicsomagolás) és eltávolítás
  src/collab.rs         közös munka: WebSocket-továbbító (csillag topológia, két token) és kliens
  src/remote.rs         SSH: profilok, multiplexelt kapcsolat, távoli fájlok/git/projekt, kernelindító szkript
  src/jobs.rs           háttérfeladatok helyben és SSH-n: indítás saját munkamenetben, napló, állapot, megszakítás
  (kernel/mod.rs)       távoli kernel: porttovábbítás, stdout-alapú segédhívás, távoli megszakítás
  (kernel/mod.rs)       debug_request: DAP a Jupyter control csatornán (Python)
  (bridge.rs)           DebugHub: az R-hibakereső parancs- és eseménycsatornája
  helpers/              a kernelekbe betöltött segédkód (R, Python)
```

A részletes architektúra a [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) fájlban található.

## Ütemterv

1. ✅ **MVP**: szerkesztő, R/Python konzol, Környezet panel, Grafikon panel
2. ✅ Adatnézegető (lapozás, rendezés, szűrés, oszlophisztogramok) és LSP (Pyright, R languageserver)
3. ✅ Projektek (renv/venv/uv), Csomagkezelő, Súgó, Fájlok panel
4. ✅ R↔Python Bridge (közös adatok), Quarto/R Markdown élő előnézet és chunkfuttatás
5. ✅ Terminál és Git (diff, ágak, előzmények, konfliktusfeloldás)
6. ✅ Hibakereső (Python: DAP/debugpy, R: saját DAP-szerű adapter)
7. ✅ Reprodukálhatósági jelentés és export
8. ✅ Bővítményrendszer (sandboxolt, jogosultság-alapú), témamegosztás (VS Code-import)
9. ✅ Távoli fejlesztés (SSH, konténer)
10. ✅ Valós idejű együttműködés (közös szerkesztés, közös kernelek, szerepek, csevegés)
11. ✅ Csiszolás: aláírt telepítők (deb/rpm/AppImage, dmg, NSIS/MSI) és akadálymentességi audit (WCAG 2.1 AA)
12. ✅ Bayesi modellezés: Stan-szerkesztő (stanc3), `{stan}` chunkok, háttérfeladatok (helyben és SSH-n, újracsatolással)
13. Illesztésvizsgáló: R-hat, ESS, divergenciák paraméterenként; trace-, rank- és pairs-ábrák; a mintavételek az
    adatnézegetőben; brms-modellek összehasonlítása (LOO); a CmdStan-verzió a reprodukálhatósági jelentésben

## Ismert korlátok

- Stan és háttérfeladatok:
  - A helyi háttérfeladatokhoz POSIX shell kell (`sh`, `setsid` vagy `nohup`): Linuxon és macOS-en működnek,
    Windowson csak WSL-ben vagy távoli (SSH) projektben. Távoli gépen a feladatok Windowstól függetlenül működnek.
  - A `#include`-dal behúzott fájlokat a szerkesztő élőben nem ellenőrzi (ezt jelzi); a CmdStan fordításkor igen.
  - A Stan-függvénykatalógus a gyakori eloszlásokat és függvényeket tartalmazza; a ritkábbakat a fordító ismeri
    (hibát nem jelez rájuk), de kiegészítést és súgót nem ad hozzájuk.
  - Az rstan párhuzamos mintavételét itt csak parancssorból teszteltük. A cmdstanr-folyamatot végig, az alkalmazásból is.
  - Az eredmény betöltése az egész `fit.rds`-t a konzol memóriájába olvassa; nagyon nagy illesztésnél (több millió
    mintavétel) ez percekig tarthat és sok memóriát igényel. 1 millió mintavétel/paraméter fölött a feladat nem számol
    összefoglalót a végén (a konzolban kérhető).
  - A Python-oldali Stan-felületek (CmdStanPy, PyMC) még nem támogatottak.

- Telepítők:
  - A Linux-csomagokat (deb, rpm, AppImage) itt lefordítottuk, a deb-et telepítettük és elindítottuk, és a GPG-s
    aláírás–ellenőrzés láncot is végigpróbáltuk.
  - A macOS- és Windows-csomagok aláírásához Apple Developer ID és Authenticode-tanúsítvány kell. Ezek a CI-ban,
    a titkok megadása után működnek; ebben a környezetben nem futtathatók.
  - A licenc és a honlap mezői a `tauri.conf.json`-ban üresek: ezeket neked kell eldöntened.
- Akadálymentesség:
  - Az automatikus audit nem vizsgálja a Monaco-szerkesztő és az xterm belsejét: ezeknek saját akadálymentes rétegük
    van (Monaco: `Alt+F1`).
  - Valódi képernyőolvasóval (NVDA, VoiceOver, Orca) még nem teszteltük.

- Közös munka:
  - **Titkosítás:** a helyi hálózati mód forgalma titkosítatlan WebSocket. Interneten vagy nem megbízható hálózaton
    SSH-alagutat (vagy VPN-t) használj.
  - **Mi nem érhető el vendégként:** terminál, git, előnézet, nyelvi szerver, hibakereső, reprodukálhatósági export.
    Ezek a megosztó gépén futnak.
  - **Szerkesztés:** a visszavonás (`Ctrl+Z`) a saját és a többiek módosításait is visszavonhatja, ha összefonódnak.
    A közösen szerkesztett fájl sorvégei LF-re állnak.
  - Egy megosztásban legfeljebb 32 vendég lehet; nagyon nagy (több tíz MB-os) szövegfájlok közös szerkesztése lassú lehet.

- Távoli fejlesztés:
  - A távoli gép Linux (GNU find/coreutils) legyen; macOS-re vagy BusyBoxra csatlakozva a fájllista nem működik.
  - Távoli projektben még nem érhető el: a nyelvi szerver (LSP), a Quarto/R Markdown előnézet, az R-hibakereső és az
    R↔Python Bridge. Ezek helyi folyamatokra épülnek; a felület ezt jelzi.
  - A Fájlok panel 8 másodpercenként és ablakfókuszkor frissül, nem azonnal (nincs távoli fájlfigyelő).
  - A parancsok és a kernelek nem interaktív (BatchMode) SSH-t használnak: kulcs vagy ssh-agent kell hozzájuk. Jelszót
    csak a terminál kérhet.
  - A konténer-receptet (`examples/remote-container`) ebben a fejlesztői környezetben nem tudtuk futtatni (nem volt
    Docker-démon); a távoli funkciókat valódi OpenSSH-szerverrel teszteltük.

- Bővítmények:
  - A `main` egyetlen ES-modul lehet: a relatív importokat egybe kell csomagolni (pl. esbuilddel).
  - A hálózati tiltás a `fetch`/XHR/WebSocket/EventSource hívásokra vonatkozik; a modulok dinamikus `import()`-ját ez a
    verzió nem tiltja. A jogosultságok a DataForge API-t (fájlok, kernelek, szerkesztő) szigorúan védik.
  - A VS Code-bővítmények közvetlenül nem futnak, mert más az API-juk. A színtémáik és snippetjeik viszont igen.
  - Még nincs bővítménypiac és automatikus frissítés: a csomagokat kézzel kell telepíteni.
- Témák: a téma az alkalmazás színeit és a szintaxis fő kategóriáit veszi át. A VS Code-témák finomabb, nyelvspecifikus
  scope-szabályai nem kerülnek át.

- Reprodukálhatóság:
  - A csomag- és adatfelismerés statikus (szövegminták). Dinamikusan összerakott fájlnevet (`paste0("data/", x)`)
    vagy változóban tárolt csomagnevet nem lát; ilyenkor a „hiányzó fájl” figyelmeztetés is elmaradhat.
  - A rendszerszintű függőségek (pl. GDAL, a Java vagy egy C-könyvtár verziója) nem kerülnek a lockfile-ba, csak a
    `sessionInfo.txt`-be. A Docker-kép ezeket nem telepíti automatikusan.
  - A Docker-képben a disztribúció Python 3-a fut, nem feltétlenül pontosan az eredeti Python-verzió; a `reproduce.sh`
    ezt jelzi.
  - Az R-csomagok visszaállítása (`renv::restore`) CRAN-hozzáférést igényel; ebben a fejlesztői környezetben a lockfile
    érvényességét a valódi renv-vel ellenőriztük, a letöltést nem.

- Hibakereső:
  - R: töréspont csak olyan sorra tehető, amely egy `{` blokkban vagy a szkript felső szintjén álló utasítás eleje.
    Egy többsoros kifejezés belső sorára tett töréspont nem áll meg. Csomagok (nem a projektben lévő) függvényeibe nem
    lehet belépni.
  - Python: a töréspontok a `debugfile()`-lal futtatott fájlokra és az általuk definiált függvényekre érvényesek. A
    konzolba beírt vagy cellaként futtatott kódra nem.
  - Kivételnél megállás („break on exception”) és feltételes töréspont még nincs.
  - Szünet közben a konzolba írt parancsok a folytatás után futnak le; szünet alatt a Kiértékelés mezőt használd.

- Git:
  - A jelszót vagy passphrase-t kérő push/pull nem kérdez rá a felületen (a git nem interaktív módban fut, hogy ne akadjon el).
    Ilyenkor érthető hibaüzenetet ad; a hitelesítést egyszer a terminálban kell beállítani (credential helper, ssh-agent).
  - Részleges (soronkénti, „hunk”) stage-elés, rebase-felület és stash-kezelés még nincs. Ezek a terminálból elérhetők.
  - Az előzménylista egyszerű lista, elágazási gráf nélkül.
- Terminál: macOS-en login shell indul (a teljes PATH miatt), Linuxon interaktív, nem login shell.

- Bridge:
  - Az átadás másolat, nem közös memória: `r.x` pillanatképet ad, a későbbi R-oldali változás nem látszik benne.
  - Ha a másik kernel éppen hosszú kódot futtat, az átadás megvárja (legfeljebb 5 percig).
  - Függvények, környezetek, modellobjektumok nem adhatók át (csak adat: adatkeret, vektor, mátrix, lista, skalár).
  - A Python-oldali `Date` oszlop pandas `datetime64` lesz (a pandasnak nincs külön dátumtípusa).
- Előnézet: a `.qmd` fájlokhoz Quarto kell (`pip install quarto-cli` vagy quarto.org); az `.Rmd` fájlokhoz R + `rmarkdown`.
  A HTML-be ágyazott oldalak sandboxolt iframe-ben futnak, ezért a böngészőtárolót használó widgetek korlátozottan működnek.

- Az `input()` / `readline()` (stdin) még nem támogatott a konzolban.
- A plotly- és HTML-kimenetek egyelőre szövegként jelennek meg a konzolban.
- A Windows-alatti megszakítás csak Pythonnál működik (R-nél a következő iterációban).
- A telepítőcsomagok (MSI/DMG/AppImage) aláírása még nincs beállítva: `pnpm tauri build` csomagol, de aláírás nélkül.
- Adatnézegető:
  - A lapok JSON-ban érkeznek. Laponként legfeljebb 1000 sorról van szó, így ez gyors.
  - A polars- és pyarrow-táblák megjelenítés előtt pandas formátumra alakulnak.
  - A teljes szöveges keresés a szöveg- és faktoroszlopokban keres, a számoszlopokban pontos egyezést néz.
- Projektek: a projektenkénti beállítások (értelmező, nyitott fájlok) az alkalmazás beállításai között tárolódnak, nem
  a projektmappában. Így a DataForge semmit sem ír a felhasználó repójába.
- Az R-csomagok frissíthetőségének ellenőrzése és a telepítés a beállított CRAN-tükörhöz fordul (hálózat kell).
- LSP:
  - Az ugrás a definícióra csak megnyitott dokumentumon belül működik.
  - Az R languageserver integrációja ugyanazon a kódúton megy, mint a Pyrighté, de ebben a fejlesztői környezetben nem
    volt telepíthető (CRAN-hozzáférés nélkül). A Pythonnal végig tesztelt, R-rel még nem.
