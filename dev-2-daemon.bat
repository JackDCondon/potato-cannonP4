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

echo Starting daemon with file watch...
cd /d "%~dp0apps\daemon"
set NODE_ENV=development
set "DAEMON_LOG=%USERPROFILE%\.potato-cannon\daemon.log"
set "WATCH_LOG=%TEMP%\potato-daemon-watch.log"
echo Streaming daemon output and auto-printing daemon log on restart failures...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$watchLog = $env:WATCH_LOG; $daemonLog = $env:DAEMON_LOG; node --watch dist/index.js 2>&1 | Tee-Object -FilePath $watchLog | ForEach-Object { $line = $_.ToString(); Write-Output $line; if ($line -match \"Daemon already running \\(PID .+\\)\\. Exiting\\.\" -or $line -match \"Failed running 'dist/index\\.js'\\. Waiting for file changes before restarting\\.\\.\\.\") { Write-Host ''; Write-Host '===== daemon.log (last 120 lines) ====='; if (Test-Path $daemonLog) { Get-Content -Path $daemonLog -Tail 120 } else { Write-Host \"daemon.log not found at $daemonLog\" }; Write-Host '========================================'; Write-Host '' } }"
