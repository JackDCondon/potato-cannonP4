@echo off
setlocal EnableExtensions

set "PROJECT_ROOT=%~dp0"
for %%I in ("%PROJECT_ROOT%") do set "PROJECT_ROOT=%%~fI"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"

set "SCAN_ONLY=0"
if /I "%~1"=="/scan" set "SCAN_ONLY=1"

echo Scanning for project daemon processes in:
echo   %PROJECT_ROOT%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$projectRoot = $env:PROJECT_ROOT;" ^
  "$scanOnly = $env:SCAN_ONLY -eq '1';" ^
  "$escapedRoot = [Regex]::Escape($projectRoot);" ^
  "$daemonHints = @('apps\\daemon\\dist\\index\\.js','apps\\daemon\\bin\\potato-cannon\\.js','apps\\daemon\\dist\\mcp\\proxy\\.js','potato-cannon','daemon\\.pid');" ^
  "$allowedNames = '^(node|npm|pnpm|yarn|bun|deno|python|java|dotnet)(\\.exe)?$';" ^
  "$processes = Get-CimInstance Win32_Process;" ^
  "$pidFile = Join-Path $env:USERPROFILE '.potato-cannon\\daemon.pid';" ^
  "$pidCandidates = @();" ^
  "if (Test-Path $pidFile) {" ^
  "  $rawPid = (Get-Content -Path $pidFile -TotalCount 1 -ErrorAction SilentlyContinue);" ^
  "  $parsed = 0;" ^
  "  if ([int]::TryParse(($rawPid | Out-String).Trim(), [ref]$parsed)) { $pidCandidates += $parsed }" ^
  "}" ^
  "$targets = $processes | Where-Object {" ^
  "  $_.CommandLine -and" ^
  "  $_.CommandLine -match $escapedRoot -and" ^
  "  (($_.Name -match $allowedNames) -or (($daemonHints | Where-Object { $_.CommandLine -match $_ }).Count -gt 0))" ^
  "};" ^
  "$targets += $processes | Where-Object { $_.ProcessId -in $pidCandidates };" ^
  "if ($pidCandidates.Count -gt 0) {" ^
  "  $targets += $processes | Where-Object { $_.Name -match '^node(\\.exe)?$' -and $_.CommandLine -and ($_.CommandLine -match '(^|\\s)--watch\\s+dist/index\\.js(\\s|$)' -or $_.CommandLine -match '(^|\\s)dist/index\\.js(\\s|$)' -or $_.CommandLine -match 'apps\\daemon\\dist\\mcp\\proxy\\.js') };" ^
  "}" ^
  "$targets = $targets | Sort-Object ProcessId -Unique;" ^
  "if (-not $targets) { Write-Host 'No ghost daemon processes found for this project.'; exit 0 }" ^
  "Write-Host 'Found process(es):';" ^
  "$targets | Sort-Object ProcessId | ForEach-Object { Write-Host ('  PID {0,-7} {1}' -f $_.ProcessId, $_.Name); Write-Host ('    ' + $_.CommandLine) };" ^
  "if ($scanOnly) { Write-Host ''; Write-Host 'Scan-only mode: no processes were killed.'; exit 0 }" ^
  "$ids = $targets.ProcessId | Sort-Object -Unique;" ^
  "foreach ($id in $ids) {" ^
  "  try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host ('Killed PID ' + $id) }" ^
  "  catch { Write-Warning ('Failed to kill PID ' + $id + ': ' + $_.Exception.Message) }" ^
  "}"

echo.
echo Done.
endlocal