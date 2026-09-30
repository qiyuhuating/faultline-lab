@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then run this file again.
  pause
  exit /b 1
)
node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]===24&&p[1]>=15?0:1)"
if errorlevel 1 (
  echo Faultline requires Node.js 24.15 or newer in the 24.x series.
  pause
  exit /b 1
)
start "Faultline Engine" cmd /k node src\server.mjs
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8787
