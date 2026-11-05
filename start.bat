@echo off
rem DataForge - egygombos inditas / one-click start (Windows)
rem Double-click to build (first run only) and launch DataForge.
rem Note: no parentheses inside echo texts or if-blocks - cmd would end the block there.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
where cargo >nul 2>nul
if errorlevel 1 goto :no_rust
where pnpm >nul 2>nul
if errorlevel 1 call :install_pnpm
where pnpm >nul 2>nul
if errorlevel 1 goto :no_pnpm

echo Fuggosegek ellenorzese...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :failed

if /i "%~1"=="--dev" goto :dev

set "BIN=src-tauri\target\release\dataforge.exe"
set REBUILD=0
if not exist "%BIN%" set REBUILD=1
if "%REBUILD%"=="1" goto :build
for /f %%i in ('powershell -NoProfile -Command "$b=(Get-Item '%BIN%').LastWriteTime; @(Get-ChildItem -Recurse -File src,src-tauri\src,src-tauri\helpers; Get-Item index.html,package.json,src-tauri\Cargo.toml,src-tauri\tauri.conf.json) | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1 | ForEach-Object { 1 }"') do set REBUILD=1
if "%REBUILD%"=="0" goto :run

:build
echo.
echo Forditas - az elso inditaskor 10-20 perc is lehet, hagyd nyitva ezt az ablakot...
echo.
call pnpm tauri build --no-bundle
if errorlevel 1 goto :failed
if not exist "%BIN%" goto :failed

:run
echo DataForge indul...
start "" "%BIN%"
exit /b 0

:dev
call pnpm tauri dev
pause
exit /b

:install_pnpm
echo pnpm telepitese...
call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 call npm install -g pnpm
exit /b 0

:no_node
echo HIBA: Node.js 20+ szukseges: https://nodejs.org
goto :stop
:no_rust
echo HIBA: Rust szukseges: https://rustup.rs - telepites utan nyisd meg ujra ezt a fajlt.
goto :stop
:no_pnpm
echo HIBA: a pnpm nem telepitheto automatikusan. Futtasd PowerShellben: npm install -g pnpm
goto :stop
:failed
echo.
echo HIBA tortent - lasd a fenti uzeneteket. Masold ki az utolso sorokat, ha segitseg kell.
goto :stop
:stop
echo.
pause
exit /b 1
