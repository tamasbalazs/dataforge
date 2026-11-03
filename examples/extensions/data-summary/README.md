# Adat-összefoglaló (DataForge példabővítmény)

Jelölj ki egy változónevet egy R- vagy Python-szkriptben, és futtasd a parancsot (`Ctrl+Alt+D`, vagy a parancspalettából):
a bővítmény a konzol munkamenetében lefuttatja a `summary()` / `describe()` hívást, és az eredményt egy panelen mutatja.
A panel gombja beszúrja a kódot a szerkesztőbe, hogy a lépés a szkriptben is megmaradjon.

Tartalmaz még R- és Python-snippeteket (`ggpoint`, `grsum`, `seed`) és egy VS Code-formátumú témát (*Fjord*).

Csomagolás: `pnpm pack:ext examples/extensions/data-summary` → `data-summary-1.0.0.dfext`.
