# Kiadás: aláírt telepítők

## Röviden

```bash
pnpm release -- --build --sign
```

Ez lefordítja az alkalmazást, majd összegyűjti a platform telepítőit a `release/<verzió>/` mappába. Mellé kerül a
`SHA256SUMS`, egy `manifest.json` (méret, ellenőrzőösszeg, aláírás-állapot fájlonként) és a `SHA256SUMS.asc`
GPG-aláírás. Ha a `package.json`, a `tauri.conf.json` és a `Cargo.toml` verziója eltér, a szkript megáll.

A GitHub Actions `release.yml` ugyanezt csinálja minden `v*` címkére Linuxon, macOS-en (Apple Silicon és Intel) és
Windowson. A végén egy közös, aláírt `SHA256SUMS` készül, és létrejön a kiadás vázlata (draft).

| Platform | Csomagok | Aláírás |
|---|---|---|
| Linux | `.deb`, `.rpm`, `.AppImage` | a `SHA256SUMS.asc` GPG-aláírás fedi le őket |
| macOS | `.dmg` (benne a `.app`) | Developer ID kódaláírás, hardened runtime, Apple-notarizáció |
| Windows | NSIS `-setup.exe`, `.msi` | Authenticode (SHA-256, időbélyeggel) |

## Aláírókulcsok beállítása

Kulcs nélkül is készülnek telepítők, csak aláíratlanul: a macOS Gatekeeper és a Windows SmartScreen ilyenkor figyelmeztet.

### macOS (Apple Developer Program szükséges)

1. Hozz létre egy **Developer ID Application** tanúsítványt, és exportáld `.p12` fájlba.
2. GitHub-titkok (secrets):
   - `APPLE_CERTIFICATE` (a `.p12` base64-ben: `base64 -i cert.p12`) és `APPLE_CERTIFICATE_PASSWORD`;
   - `APPLE_SIGNING_IDENTITY` (pl. `Developer ID Application: Név (TEAMID)`);
   - a notarizációhoz: `APPLE_ID`, `APPLE_PASSWORD` (alkalmazás-specifikus jelszó) és `APPLE_TEAM_ID`.
3. Helyben ugyanezek a környezeti változók kellenek; a Tauri aláír, notarizál, és rátűzi (staple) a jegyet.

A `src-tauri/macos/entitlements.plist` a hardened runtime-hoz szükséges jogokat tartalmazza: JIT a WebView-nak,
hálózat a kernelekhez és a közös munkához.

### Windows

- **Tanúsítványfájllal:** `WINDOWS_CERTIFICATE` (base64 `.pfx`) és `WINDOWS_CERTIFICATE_PASSWORD`. A workflow a
  felhasználói tanúsítványtárba importálja, és a `TAURI_CONFIG`-on át megadja az ujjlenyomatát; az időbélyeg-szolgáltató
  `http://timestamp.digicert.com`.
- **Felhős aláírással** (Azure Trusted Signing, HSM-es EV-tanúsítvány): állítsd be a `bundle.windows.signCommand`-ot.
  Példa: `"signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"`.

### GPG (minden platform)

```bash
gpg --quick-gen-key "DataForge Release <release@…>" ed25519 sign 2y
gpg --armor --export release@… > dataforge-release-key.asc            # ezt tedd közzé
gpg --armor --export-secret-keys release@… | pbcopy                    # → RELEASE_GPG_PRIVATE_KEY
```

Titkok: `RELEASE_GPG_PRIVATE_KEY`, és ha a kulcsnak van jelszava, `RELEASE_GPG_PASSPHRASE`. Helyben a
`DATAFORGE_GPG_KEY` választja ki a kulcsot (alapértelmezés: a gpg alapkulcsa).

## Ellenőrzés a felhasználónál

```bash
gpg --import dataforge-release-key.asc
scripts/verify-release.sh ~/Letöltések/dataforge-0.1.0
```

Ez ellenőrzi a `SHA256SUMS` aláírását és a mappában lévő telepítők ellenőrzőösszegét. Hamis vagy sérült fájlnál
megáll és szól. Windowson ugyanez: `scripts/verify-release.ps1`, amely az Authenticode-aláírást is megnézi.

## Kiadási lista

1. Verzió emelése mindhárom helyen: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
2. Zöld CI: típusellenőrzés, egység-, Rust- és e2e-tesztek, akadálymentességi audit.
3. `git tag v0.2.0 && git push --tags`, majd a vázlat ellenőrzése és közzététele a GitHubon.
