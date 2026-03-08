#!/usr/bin/env node
/**
 * Windows build fix: install a 7za.exe wrapper that suppresses exit code 2.
 *
 * Problem: winCodeSign-2.6.0.7z (used by electron-builder) contains macOS
 * symlinks (darwin/) that 7-Zip cannot create on Windows without Developer
 * Mode enabled (SeCreateSymbolicLinkPrivilege). 7za exits with code 2, which
 * app-builder.exe treats as fatal — even though all needed Windows tools were
 * extracted successfully.
 *
 * Fix: replace 7zip-bin's bundled 7za.exe with a small wrapper that calls the
 * real 7za_real.exe and converts exit code 2 → 0.
 *
 * Requirements: .NET SDK 6+ (dotnet CLI must be on PATH)
 *
 * This script is idempotent: if 7za_real.exe already exists, it skips.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// Only run on Windows
if (process.platform !== 'win32') {
  process.exit(0);
}

const require = createRequire(import.meta.url);

let sevenZipBinPath;
try {
  const sevenZipBin = require('7zip-bin');
  sevenZipBinPath = sevenZipBin.path7za;
} catch {
  console.log('[7za-wrapper] 7zip-bin not found, skipping wrapper install.');
  process.exit(0);
}

const sevenZipDir = dirname(sevenZipBinPath);
const realExe = join(sevenZipDir, '7za_real.exe');
const wrapperExe = sevenZipBinPath; // replaces 7za.exe in-place

// Idempotent check
if (existsSync(realExe)) {
  console.log('[7za-wrapper] Already installed (7za_real.exe exists), skipping.');
  process.exit(0);
}

// Check dotnet is available
const dotnetCheck = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
if (dotnetCheck.status !== 0) {
  console.warn('[7za-wrapper] WARNING: dotnet CLI not found. Cannot install 7za wrapper.');
  console.warn('[7za-wrapper] To fix Windows builds, either:');
  console.warn('[7za-wrapper]   1. Install .NET SDK and re-run pnpm install');
  console.warn('[7za-wrapper]   2. Enable Windows Developer Mode');
  process.exit(0); // Non-fatal: warn but don't break install
}

console.log('[7za-wrapper] Installing 7za wrapper for Windows build compatibility...');

// Create temp project
const tmpDir = join(tmpdir(), `7za-wrapper-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

writeFileSync(join(tmpDir, '7za_wrapper.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <SelfContained>true</SelfContained>
    <PublishSingleFile>true</PublishSingleFile>
    <AssemblyName>7za</AssemblyName>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>`);

writeFileSync(join(tmpDir, 'Program.cs'), `using System;
using System.Diagnostics;
using System.IO;

// Wrapper for 7za.exe used by electron-builder (via app-builder.exe / SZA_PATH env var).
// Suppresses exit code 2 which occurs when extracting winCodeSign-2.6.0.7z on Windows
// without Developer Mode: the archive contains macOS symlinks that cannot be created
// without SeCreateSymbolicLinkPrivilege, but all needed Windows files ARE extracted first.

var exeDir = Path.GetDirectoryName(System.Environment.ProcessPath) ?? "";
var real7za = Path.Combine(exeDir, "7za_real.exe");

if (!File.Exists(real7za))
{
    Console.Error.WriteLine($"[7za-wrapper] ERROR: Real 7za not found at {real7za}");
    return 1;
}

var psi = new ProcessStartInfo
{
    FileName = real7za,
    UseShellExecute = false,
    RedirectStandardOutput = false,
    RedirectStandardError = false,
};

foreach (var arg in args)
    psi.ArgumentList.Add(arg);

var proc = Process.Start(psi)!;
proc.WaitForExit();
int exit = proc.ExitCode;

if (exit == 2)
{
    Console.Error.WriteLine("[7za-wrapper] 7za exited with code 2 (likely macOS symlink creation failed on Windows). Treating as success.");
    return 0;
}

return exit;
`);

const publishDir = join(tmpDir, 'publish');
const result = spawnSync(
  'dotnet',
  ['publish', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
   '-p:PublishSingleFile=true', '-o', publishDir, '--nologo', '-v', 'q'],
  { cwd: tmpDir, encoding: 'utf8', stdio: 'inherit' }
);

if (result.status !== 0) {
  console.error('[7za-wrapper] ERROR: Failed to compile 7za wrapper. Build may fail on Windows.');
  console.error('[7za-wrapper] To fix: enable Windows Developer Mode and re-run pnpm install.');
  process.exit(0); // Non-fatal
}

const compiledExe = join(publishDir, '7za.exe');
if (!existsSync(compiledExe)) {
  console.error('[7za-wrapper] ERROR: Compiled wrapper not found at expected path.');
  process.exit(0);
}

// Rename original 7za.exe → 7za_real.exe, place wrapper as 7za.exe
copyFileSync(wrapperExe, realExe);
copyFileSync(compiledExe, wrapperExe);

console.log('[7za-wrapper] Wrapper installed successfully.');
console.log(`[7za-wrapper]   real binary → ${realExe}`);
console.log(`[7za-wrapper]   wrapper     → ${wrapperExe}`);
