@echo off
title Potato Cannon - Daemon
echo Waiting for dist/index.js to be compiled...

:waitloop
if exist "%~dp0apps\daemon\dist\index.js" goto start
timeout /t 1 /nobreak >nul
goto waitloop

:start
echo Stopping any existing daemon...
node "%~dp0apps\daemon\bin\potato-cannon.js" stop 2>nul
del "%USERPROFILE%\.potato-cannon\daemon.pid" 2>nul
rmdir /s /q "%USERPROFILE%\.potato-cannon\daemon.lock.lock" 2>nul
timeout /t 1 /nobreak >nul

echo Starting daemon with debounced file watch...
cd /d "%~dp0apps\daemon"
set NODE_ENV=development
node scripts/watch-daemon.mjs
