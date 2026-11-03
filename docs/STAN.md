# Bayesi modellezés Stannel

A DataForge a Stan-modelleket a teljes munkafolyamatban támogatja:
- a modell megírását (élő fordítóellenőrzéssel);
- az R-adatlista összeállítását;
- a hosszú mintavételt háttérfeladatként, akár egy távoli gépen;
- az eredmény betöltését a konzolba.

A cmdstanr, az rstan és a brms is használható.

## Gyors kezdés

1. **Új modell:** parancspaletta (`Ctrl+Shift+P`) → *Új Stan-modell*. A sablon egy egyszerű normális modell.
   Meglévő `.stan` fájlt a Fájlok panelről nyithatsz meg.
2. **Írd a modellt.** Az eszköztár jelzője gépelés közben mutatja, hogy a modell **lefordítható-e**. Hibánál a hely
   aláhúzva látszik, a fordító üzenete rámutatva vagy az `F8`-cal olvasható.
3. **Adatok:** az eszköztár *R adatlista-sablon a vágólapra* gombja a `data` blokkból egy `stan_data <- list(...)` vázat másol a
   vágólapra. Illeszd be egy R-szkriptbe, töltsd ki, és futtasd a konzolban.
4. **Mintavétel:** az eszköztár *Mintavétel háttérfeladatként…* gombja.
   - Válaszd ki az adatlistát (a DataForge felajánlja a konzol listáit, a `stan_data`-t előre kiválasztja).
   - Állítsd be a láncokat és az iterációkat → **Indítás**.
5. **Követés:** a *Háttérfeladatok* panel (`Ctrl+Alt+J`) láncokra bontva mutatja a bemelegítést és a mintavételt, a
   hátralévő időt, a végén a divergenciákat és az összefoglalót.
6. **Eredmény:** *Betöltés: fit* (vagy az értesítés gombja) → a konzolban `fit <- readRDS(...)`. Innen a megszokott
   eszközökkel dolgozhatsz tovább (`fit$summary()`, `posterior`, `bayesplot`).

## A szerkesztő

| Funkció | Hogyan |
|---|---|
| Hibaellenőrzés | automatikus, gépelés után kb. 0,35 s-mal; a fájlt nem kell menteni |
| Következő hiba | `F8` |
| Pedáns figyelmeztetések | eszköztár → *Pedáns ellenőrzés*: prior nélküli paraméter, nem használt változó, gyanús korlátok |
| Kiegészítés | `Ctrl+Space`; a `~` után eloszlások paraméterekkel, egyébként függvények, típusok, a modell változói |
| Súgó | vidd az egeret egy eloszlás vagy függvény fölé |
| Formázás | `Shift+Alt+F` vagy eszköztár → *Formázás (stanc)* |
| Fordítás a konzolban | eszköztár → *Fordítás az R-konzolban (cmdstanr)*: `<név>_mod <- cmdstanr::cmdstan_model("…")` |

Az ellenőrzést a **hivatalos stanc3 fordító** (v2.36.0, JavaScript-változat) végzi. Hálózati hozzáférés nélküli
Web Workerben fut, így a modell kódja nem hagyja el a gépet, és nem kell hozzá telepített CmdStan sem. A fordító
ellenőrzőösszeggel és forrásmegjelöléssel a `public/vendor/stanc/` mappában van.

A `#include`-dal behúzott fájlokat a szerkesztő nem éri el, ezért ezekre nem jelez hibát (egy információs jelzés
mutatja ezt). A CmdStan fordításkor ellenőrzi őket.

## Stan Quarto- és R Markdown-dokumentumban

````markdown
```{r}
library(cmdstanr)
register_knitr_engine()
```

```{stan output.var="modell"}
data { int N; vector[N] y; }
parameters { real mu; real<lower=0> sigma; }
model { y ~ normal(mu, sigma); }
```

```{r}
fit <- modell$sample(data = list(N = 3, y = c(1, 2, 3)))
```
````

- A DataForge a `{stan}` chunkot a `output.var`-ban megadott néven fordítja le a konzolban.
- Ha a dokumentum meghívja a `register_knitr_engine()`-t, cmdstanr-rel fordít (`CmdStanModel`), különben
  `rstan::stan_model()`-lel.
- Az `output.var` a fejlécben vagy Quarto-stílusban is megadható (`#| output.var: modell`).

## brms és rstan

- **Stan-kód megtekintése:** a Környezet panelen egy `brmsfit`, `stanfit`, `stanmodel` vagy `CmdStanModel` objektum
  mellett a *<név> Stan-kódja* gomb a mögöttes Stan-programot új szerkesztőfülön nyitja meg. Brms-nél ez a
  generált kód, ami jól jön, ha meg akarod érteni vagy át akarod írni a modellt.
- **Hosszú brms-illesztés:** nyisd meg az illesztő R-szkriptet, és a szerkesztő *Futtatás háttérfeladatként…* gombjával (processzor ikon)
  (vagy a Háttérfeladatok panelről) indítsd el.
  - Az *Objektumok mentése betöltéshez* bekapcsolva a szkript végén minden létrehozott objektum (pl. a `brmsfit`)
    mentődik.
  - Az *Eredmények betöltése* ezeket a konzol globális környezetébe tölti.
- **rstan a mintavételi ablakban:** a *Felület* kapcsolóval. A beállítások ugyanazok, a `warmup`/`iter` átszámítás
  automatikus.

## Háttérfeladatok

### Hol fut?

A feladat a **projekt gépén** fut, egy külön `Rscript`-folyamatban:
- helyi projektnél a saját gépeden;
- távoli (SSH) projektnél a távoli gépen.

A DataForge a feladatot saját munkamenetben (`setsid`) indítja, így a folyamat független az alkalmazástól és az SSH-kapcsolattól.

| Esemény | Mi történik a feladattal? |
|---|---|
| Bezárod a DataForge-ot | fut tovább; újraindításkor a panel újra követi |
| Megszakad az SSH-kapcsolat (alvó laptop, hálózatváltás) | fut tovább; a panel jelzi a kapcsolat elvesztését, és visszatéréskor folytatja a követést |
| Újraindítod a konzolt | fut tovább (nem a konzolban fut) |
| *Megszakítás* gomb | a feladat teljes folyamatcsoportja leáll (először `TERM`, majd `KILL`) |
| A távoli gép újraindul | a feladat leáll; a panel a naplót és az utolsó állapotot mutatja |

Ha egy feladat akkor fejeződik be, amikor a DataForge nem fut, a következő indításkor egy értesítés jelzi, rajta az
eredmények betöltése gombbal.

### A feladat mappája

Minden feladatnak saját mappája van: `~/.dataforge/jobs/<azonosító>/` a projekt gépén. A hely a `DATAFORGE_JOBS_ROOT`
környezeti változóval módosítható.

| Fájl | Tartalom |
|---|---|
| `job.json` | név, típus, munkakönyvtár, indítás ideje, beállítások |
| `job.R` | a futtatott R-kód (megnézhető, kézzel is futtatható) |
| `log` | a teljes kimenet (stdout és stderr) |
| `pid`, `exit` | folyamatazonosító; kilépési kód a befejezéskor |
| `draws/` | cmdstanr: a láncok CSV-fájljai |
| `fit.rds` / `result.rds` | az eredmény (Stan-illesztés / a szkript objektumai) |

A konzolban kiválasztott adatlista az indításkor egy `.rds` fájlba mentődik (`~/.dataforge/job-inputs/`). A feladat
ezt olvassa, így a lista későbbi módosítása nem hat a futó feladatra.

A feladat törlése (kuka ikon) a mappát is törli. Futó feladat nem törölhető, előbb meg kell szakítani.

### Diagnosztika a panelen

- **Divergens átmenetek:** a darabszám, és tanács: növeld az `adapt_delta`-t (pl. 0,95), vagy paraméterezd újra a
  modellt (nem-centrált paraméterezés). Ez gyakori a hierarchikus modelleknél.
- **`max_treedepth` elérése:** hatékonysági jelzés; a `max_treedepth` emelhető.
- **R-hat, ESS, E-BFMI** figyelmeztetések, ha a cmdstanr vagy az rstan kiírja őket.
- **R-hibák** kiemelve, a többsoros üzenetek egyben.

Nagyon nagy mintavételnél (paraméterenként 1 millió mintavétel fölött) a feladat nem számol összefoglalót a végén,
mert az percekig tartana. Ilyenkor a betöltés után a konzolban kérhető (`fit$summary()`).

## Hibaelhárítás

- **„Fordító nem elérhető” az eszköztáron:** a stanc3 a felület része. Ha ez a hiba jelenik meg, a telepítés sérült; telepítsd
  újra a DataForge-ot.
- **A feladat azonnal hibával áll le, „there is no package called 'cmdstanr'”:** a projekt gépén (távoli projektnél a
  távoli gépen) nincs telepítve a cmdstanr. Telepítsd a README előfeltételei szerint.
- **„CmdStan path has not been set”:** futtasd a projekt gépén a `cmdstanr::install_cmdstan()`-t.
- **A mintavételi ablak nem ajánl adatot:** a konzolban nincs lista vagy adattábla. Futtasd előbb az adatot előállító
  kódot (pl. a sablonból készült `stan_data <- list(...)`), majd nyisd meg újra az ablakot.
- **Windows, helyi projekt:** a helyi háttérfeladatokhoz POSIX shell kell. Használj WSL-t, vagy futtasd a feladatot
  egy távoli (SSH) gépen.
