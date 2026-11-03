#!/usr/bin/env bash
# DataForge – egygombos indítás / one-click start (Linux, macOS)
#
#   ./start.sh                     build if needed, then launch
#   ./start.sh --dev               development mode with hot reload
#   ./start.sh --install-shortcut  add a "DataForge" launcher to the app menu (Linux)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "${1:-}" == "--install-shortcut" ]]; then
  [[ "$(uname)" == "Linux" ]] || fail "Csak Linuxon szükséges; macOS-en használd a start.command fájlt."
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$dir"
  cat > "$dir/dataforge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=DataForge
Comment=R és Python adatelemző környezet
Exec="$ROOT/start.sh"
Icon=$ROOT/src-tauri/icons/icon.png
Terminal=false
Categories=Development;Science;
DESKTOP
  say "Indító létrehozva: $dir/dataforge.desktop"
  exit 0
fi

# --- prerequisites -----------------------------------------------------------
have node  || fail "Node.js 20+ szükséges / required: https://nodejs.org"
have cargo || fail "Rust szükséges / required: https://rustup.rs"
if ! have pnpm; then
  say "pnpm telepítése (corepack)…"
  corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null
fi
if [[ "$(uname)" == "Linux" ]] && have pkg-config && ! pkg-config --exists webkit2gtk-4.1; then
  fail "Hiányzik a WebKitGTK. Ubuntu/Debian alatt:
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev build-essential"
fi

if [[ ! -d node_modules ]]; then
  say "Függőségek telepítése…"
  pnpm install --frozen-lockfile
fi

if [[ "${1:-}" == "--dev" ]]; then
  exec pnpm tauri dev
fi

# --- build when sources changed, then launch ---------------------------------
BIN="src-tauri/target/release/dataforge"

needs_build() {
  [[ ! -x "$BIN" ]] && return 0
  [[ -n "$(find src src-tauri/src src-tauri/helpers index.html package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json \
            -newer "$BIN" -print -quit 2>/dev/null)" ]]
}

if needs_build; then
  if [[ -x "$BIN" ]]; then say "Változás észlelve, újrafordítás…"; else say "Első indítás: fordítás (néhány perc, csak egyszer)…"; fi
  pnpm tauri build --no-bundle
fi

say "DataForge indul…"
exec "$BIN" "$@"
