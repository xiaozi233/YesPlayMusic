@echo off
setlocal
REM Put this file in the repository root (next to package.json) and double-click it.
cd /d "%~dp0"
if not exist "package.json" (
  echo [build] package.json not found. Put build-app.cmd in the YesPlayMusic repo root.
  pause
  exit /b 1
)
node scripts\build-app.js %*
echo.
pause
