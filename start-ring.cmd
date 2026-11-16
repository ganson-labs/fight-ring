@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:4848 -TimeoutSec 1) | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 start "Ring server" /min node serve.mjs
timeout /t 2 /nobreak >nul
start "" http://localhost:4848
