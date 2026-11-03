# Közös munka (valós idejű együttműködés)

Egy projektet megoszthatsz másokkal: a résztvevők valós időben, egyszerre szerkesztik a fájlokat, látják egymás
kurzorát, és a szerepüktől függően a te kerneleidben futtathatnak kódot. A fájlok, a kernelek és a futtatás végig a
**megosztó gépén** maradnak; a vendégek a saját DataForge-felületükön át dolgoznak velük.

## Megosztás

1. Nyiss meg egy projektet, majd **Projekt megosztása…** (`Ctrl+Alt+L`, vagy a címsor jobb oldalán a résztvevők ikon).
2. Add meg a neved, és válaszd ki:
   - **Ki érheti el?**
     - *Csak ez a gép* (alapértelmezett): a kapcsolat csak a `127.0.0.1`-en érhető el. Másik gépről SSH-alagúttal:
       `ssh -L <port>:127.0.0.1:<port> <a megosztó gépe>`, utána a meghívó változatlanul működik. Ez titkosított és
       a legbiztonságosabb.
     - *Helyi hálózat*: bárki csatlakozhat a hálózatról, akinél a meghívó van. A forgalom **nem titkosított**.
   - **Új résztvevők szerepe** (később személyenként módosítható).
3. **Megosztás indítása** → a *Közös munka* panelen megjelenik a **meghívó** (`dataforge://join/<cím>:<port>/<kód>`).
   Másold ki, és küldd el. A meghívó egy véletlen 256 bites kódot tartalmaz: kezeld jelszóként.

## Csatlakozás

**Csatlakozás munkamenethez…** (parancspaletta) → illeszd be a meghívót, add meg a neved. A megosztott projekt
megnyílik (*„projekt · megosztva”*), a Fájlok panel a megosztó fájljait mutatja, a konzol, a Környezet panel, az
adatnézegető és a grafikonok pedig a megosztó kerneleit. Kilépéskor (vagy ha a megosztó befejezi) visszakerülsz a
saját projektedbe.

## Szerepek

| Szerep | Mit tehet |
|---|---|
| **Néző** | látja a fájlokat, a kurzorokat, a konzolt, a változókat és az adatokat; a szerkesztője csak olvasható |
| **Szerkesztő** | ezen felül szerkesztheti, mentheti, létrehozhatja és átnevezheti a projekt fájljait |
| **Futtató** | ezen felül kódot futtathat a megosztó kerneleiben. **Ez a megosztó gépén tetszőleges kód futtatását jelenti** – csak megbízható társnak add. |

A megosztó a *Közös munka* panelen bármikor módosíthatja a szerepeket, és eltávolíthat bárkit.

## Amit a panel tud

- **Résztvevők:** szín, név, szerep, és hogy ki melyik fájlban van.
- **Követés** (szem ikon): a te szerkesztőd is azt a fájlt és sort mutatja, amit a követett személy.
- **Csevegés**, olvasatlan üzenetek száma a státuszsoron.
- A konzolban a mások által futtatott kód mellett ott a futtató neve.

## Biztonság

- A vendégek **csak a megosztónak** küldenek üzenetet; a megosztó DataForge-a minden kérést a vendég szerepéhez mér:
  - fájlok csak a projekten belül érhetők el, `..` és abszolút út nem;
  - a kernel-segédfüggvények közül vendégnek csak az olvasók (változólista, adatnézegető, súgó, csomaglista) érhetők el, a futtatás csak *Futtató* szerepben;
  - a nézők módosításait a megosztó eldobja.
- Terminál, git, előnézet, nyelvi szerver és hibakereső a vendégeknek nem érhető el: ezek a megosztó gépén
  futnának.
- Ha a megosztó másik projektre vált, kilép, vagy az alkalmazás leáll, a munkamenet véget ér, és a port bezárul.
