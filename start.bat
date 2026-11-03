@echo off
rem DataForge - egygombos inditas / one-click start (Windows)
rem Double-click to build (first run only) and launch DataForge.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js 20+ szukseges: https://nodejs.org & pause & exit /b 1)
where cargo >nul 2>nul || (echo Rust szukseges: https://rustup.rs & pause & exit /b 1)
where pnpm >nul 2>nul || (call corepack enable || call npm install -g pnpm)

if not exist node_modules (
  echo Fuggosegek telepitese...
  call pnpm install --frozen-lockfile || (pause & exit /b 1)
)

if "%1"=="--dev" (
  call pnpm tauri dev
  exit /b
)

set BIN=src-tauri\target\release\dataforge.exe
set REBUILD=0
if not exist "%BIN%" set REBUILD=1
if "%REBUILD%"=="0" (
  for /f %%i in ('powershell -NoProfile -Command "$b=(Get-Item '%BIN%').LastWriteTime; @(Get-ChildItem -Recurse -File src,src-tauri\src,src-tauri\helpers; Get-Item index.html,package.json,src-tauri\Cargo.toml,src-tauri\tauri.conf.json) | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1 | ForEach-Object { 1 }"') do set REBUILD=1
)
if "%REBUILD%"=="1" (
  echo Forditas (elso inditaskor nehany perc)...
  call pnpm tauri build --no-bundle || (pause & exit /b 1)
)

start "" "%BIN%"
