# Távoli fejlesztés (SSH, konténer)

A DataForge egy SSH-n elérhető gép (szerver, felhős VM, HPC-belépőgép, konténer) mappáját ugyanúgy megnyitja, mint egy
helyi projektet. A fájlok, a terminál, a git és **mindkét kernel a távoli gépen** fut; a felület helyben marad.

## Gyors kezdés

1. **Távoli gép (SSH)…** (`Ctrl+Alt+K`, vagy a státuszsor bal szélén a szerver ikon) → **Új gép**.
2. Töltsd ki: *Gép* (gépnév, IP vagy `~/.ssh/config`-álnév; a `user@gep:port` alak is beírható), és ha kell,
   *Felhasználó*, *Port*, *Kulcsfájl*, *Kezdőmappa*. **Mentés** → a DataForge kapcsolódik, és felsorolja a gépen talált
   R- és Python-értelmezőket.
3. Válaszd ki a mappát a böngészőben → **Megnyitás**. A státuszsoron megjelenik az `SSH: <név>` jelző.

A mentett gépek a parancspalettában is megjelennek (*Mappa megnyitása itt: … (SSH)*), a távoli projektek pedig a
legutóbbi projektek között.

## Mi kell a távoli gépen?

- Linux, `sh`, GNU `find`/coreutils, `git` (a Git panelhez);
- Python `ipykernel`-lel és/vagy R `IRkernel`-lel és `jsonlite`-tal. Ha hiányzik, az ablak megmutatja a telepítő parancsot.
- A projekt saját `.venv`/`venv`-je automatikusan felismerődik, és elsőbbséget kap.

## Hitelesítés

A DataForge a rendszer `ssh`-kliensét használja, így minden érvényes, ami a terminálban is: `ssh-agent`, kulcsok,
`~/.ssh/config` (`Host`, `ProxyJump`, `IdentityFile`), `known_hosts`. Új gép kulcsát az első kapcsolódáskor elfogadja
(`accept-new`), megváltozott kulcsnál viszont megáll és szól.

A fájlműveletek és a kernelek **nem interaktív** módban futnak, ezért kulcsos belépés kell. Jelszót a DataForge nem
kér és nem tárol; a beépített terminál viszont bekérheti.

## Mi működik távoli projektben?

| Funkció | Távoli projektben |
|---|---|
| Fájlok, szerkesztő, mentés | ✅ (a Fájlok panel 8 mp-enként és fókuszkor frissül) |
| R- és Python-konzol, Környezet, adatnézegető, grafikonok, súgó, csomagok | ✅ a gépen futó kernellel |
| Terminál | ✅ távoli login shell a projektmappában |
| Git panel | ✅ |
| Python-hibakereső | ✅ |
| Reprodukálhatósági export | ✅ (a csomag helyben készül) |
| Nyelvi szerver, Quarto-előnézet, R-hibakereső, R↔Python Bridge | ❌ egyelőre csak helyben |

## Konténer

Az [`examples/remote-container`](../examples/remote-container) egy Ubuntu-alapú képet épít R-rel (IRkernel),
Pythonnal (ipykernel, pandas), gittel és SSH-szerverrel:

```bash
examples/remote-container/run.sh ~/projektek/elemzes   # a mappa a konténerben: /home/ana/work
```

Ezután a DataForge-ban: Gép `127.0.0.1`, Felhasználó `ana`, Port `2222`, Kezdőmappa `/home/ana/work`. A port csak a
`127.0.0.1`-en érhető el, jelszavas belépés nincs, csak a megadott nyilvános kulcs léphet be.

## Hibaelhárítás

- **„authentication failed”:** add hozzá a kulcsot az agenthez (`ssh-add`), vagy adj meg kulcsfájlt.
- **„host key verification failed”:** a gép kulcsa megváltozott; ellenőrizd, majd töröld a régit:
  `ssh-keygen -R <gép>`.
- **Nincs kernel:** telepítsd a gépen (`python3 -m pip install ipykernel`, illetve R-ben `install.packages("IRkernel")`),
  majd a gép ablakában **Bontás** és újra **Kapcsolódás**.
- **A kapcsolat megszakadt:** a felugró értesítésben az **Újrakapcsolódás** gomb újracsatlakozik, és újraindítja a
  kerneleket.
