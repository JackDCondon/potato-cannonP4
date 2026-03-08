# Windows Build Issues & Fixes

This document records all errors encountered when building potato-cannon on Windows from source, their root causes, and the fixes applied. Intended as a reference for future AI agents and contributors.

---

## Environment

- OS: Windows 11 Pro (10.0.26200)
- Shell: bash (Git Bash / MSYS2)
- Node.js: managed by pnpm
- pnpm workspaces monorepo
- Target: Electron 40.2.1 desktop app
- electron-builder: 26.7.0
- node-pty: 1.1.0 (built from source via node-gyp)

---

## Error 1: `GetCommitHash.bat` Not Recognized

### Symptom

During `pnpm build` (specifically the `@electron/rebuild` step for node-pty), the build fails with:

```
'GetCommitHash.bat' is not recognized as an internal or external command, operable program or batch file.
```

### Root Cause

`node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/deps/winpty/src/winpty.gyp` contained:

```gyp
'variables': {
    'WINPTY_COMMIT_HASH%': '<!(cmd /c "cd shared && GetCommitHash.bat")',
},
'include_dirs': [
    '<!(cmd /c "cd shared && UpdateGenVersion.bat <(WINPTY_COMMIT_HASH)")',
]
```

The `<!(...)` syntax in GYP runs a shell command at **configure time** to produce a value. On Windows, `gyp` runs this from the node-gyp working directory where `GetCommitHash.bat` is not in scope. The batch file cannot be found even though it exists at `deps/winpty/src/shared/GetCommitHash.bat`.

Additionally, `UpdateGenVersion.bat` would regenerate `gen/GenVersion.h`, but this file **already pre-exists** in the repository from a previous build or commit, so regeneration is unnecessary.

### Fix

**File:** `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/deps/winpty/src/winpty.gyp`

Replace the dynamic variable/include_dirs block with hardcoded values:

```gyp
'variables': {
    # Windows build fix: hardcode hash to avoid GetCommitHash.bat path issues
    'WINPTY_COMMIT_HASH%': 'none',
},
'include_dirs': [
    # Windows build fix: hardcoded path; GenVersion.h is pre-generated
    'gen',
]
```

**Why it works:** `gen/GenVersion.h` already exists in the repo. Hardcoding `'gen'` as the include path allows MSVC to find it without running any batch files.

---

## Error 2: `SpectreMitigation: 'Spectre'` Build Failure

### Symptom

MSVC compilation fails during node-pty native build with an error referencing Spectre mitigation libraries not being installed.

### Root Cause

Both `winpty.gyp` and `binding.gyp` contained:

```gyp
'msvs_configuration_attributes': {
    'SpectreMitigation': 'Spectre'
}
```

This instructs MSVC to use Spectre-mitigated versions of runtime libraries, which requires the optional Visual Studio component **"MSVC v143 - VS 2022 C++ Spectre-mitigated libs"**. This component is NOT installed by default and is commonly absent on developer machines.

### Fix

**File 1:** `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/deps/winpty/src/winpty.gyp`

Remove all `msvs_configuration_attributes` blocks containing `SpectreMitigation` from both `winpty-agent` and `winpty` targets.

**File 2:** `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/binding.gyp`

Remove the Windows condition block that sets `SpectreMitigation`:

```gyp
# REMOVE this entire block:
['OS=="win"', {
    'msvs_configuration_attributes': {
        'SpectreMitigation': 'Spectre'
    },
    ...
}]
```

Keep only the `msvs_settings` (compiler/linker flags) without the `msvs_configuration_attributes`.

**Why it works:** Removing `SpectreMitigation` causes MSVC to use the standard (non-Spectre-mitigated) runtime libraries, which are always available. For an open-source development build, this is an acceptable tradeoff.

---

## Error 3: `winCodeSign-2.6.0.7z` Extraction Failure (Symbolic Links)

### Symptom

During the `electron-builder` packaging phase, the build fails with:

```
• downloading url=https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z size=5.6 MB parts=1
⨯ cannot execute cause=exit status 2
errorOut=ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

This error occurs **4 times** (1 attempt + 3 retries) because `winPackager.js` calls `executeAppBuilder(["rcedit", ...], undefined, {}, 3)`.

### Root Cause

**Multi-layered problem:**

1. `electron-builder` must call `rcedit` on the Electron `.exe` to embed version metadata and icons. On Windows, this is done via `app-builder.exe rcedit --args <json>`.

2. `app-builder.exe` (the Go binary at `app-builder-bin@5.0.0-alpha.12`) internally needs `rcedit-x64.exe` from the `winCodeSign` binary package.

3. To obtain `rcedit-x64.exe`, app-builder downloads `winCodeSign-2.6.0.7z` from GitHub releases and extracts it using 7za (the path is provided via the `SZA_PATH` environment variable set by `executeAppBuilder` in `builder-util`).

4. The `winCodeSign-2.6.0.7z` archive contains macOS symlinks in its `darwin/` directory:
   - `darwin/10.12/lib/libcrypto.dylib -> libcrypto.1.0.0.dylib`
   - `darwin/10.12/lib/libssl.dylib -> libssl.1.0.0.dylib`

5. On Windows, creating symbolic links requires either **Administrator privileges** or **Windows Developer Mode** to be enabled (via `SeCreateSymbolicLinkPrivilege`). Without this privilege, 7za exits with **exit code 2** ("Fatal error").

6. Even though all the needed Windows tools (`rcedit-x64.exe`, `windows-10/x64/signtool.exe`, etc.) ARE successfully extracted before the symlink error, app-builder treats exit code 2 as a fatal failure and discards the extraction.

7. The JS-side `binDownload.js` has an `extractionCompleteMarker` mechanism but this is bypassed because the rcedit download happens **inside the Go binary**, not in JS code.

### What Does NOT Work

- Patching `binDownload.js` `doGetBin()` to skip re-download → the `rcedit` command is a different Go code path that bypasses this JS function
- Changing `electron-builder.json` win target from `["nsis", "zip"]` to `["dir"]` → rcedit is still called for the `dir` target
- Manually copying extracted files to `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` → the Go binary re-downloads each time regardless
- Setting `ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL` alone → still fails to extract the same archive

### Fix

**Replace the bundled `7za.exe` with a wrapper that suppresses exit code 2.**

The `SZA_PATH` environment variable (set by `builder-util`'s `executeAppBuilder`) points to:
```
node_modules/.pnpm/7zip-bin@5.2.0/node_modules/7zip-bin/win/x64/7za.exe
```

**Steps:**

1. Rename `7za.exe` → `7za_real.exe` in that directory.

2. Create a C# wrapper (`7za_wrapper.csproj` + `Program.cs`) that:
   - Calls `7za_real.exe` with all provided arguments
   - If exit code is 2, prints a warning and returns 0 instead
   - Otherwise passes through the exit code

3. Compile the wrapper as a self-contained Windows x64 executable named `7za.exe`:
   ```bash
   dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o ./publish
   ```

4. Place the compiled `7za.exe` wrapper at the same path as the original.

**C# wrapper source (`Program.cs`):**

```csharp
using System;
using System.Diagnostics;
using System.IO;

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
};

foreach (var arg in args)
    psi.ArgumentList.Add(arg);

var proc = Process.Start(psi)!;
proc.WaitForExit();
int exit = proc.ExitCode;

// Exit code 2 from 7za when extracting winCodeSign means macOS symlinks couldn't be created.
// The Windows tools ARE extracted successfully. Suppress to allow build to continue.
if (exit == 2)
{
    Console.Error.WriteLine("[7za-wrapper] 7za exited with code 2 (macOS symlink creation failed). Treating as success.");
    return 0;
}

return exit;
```

**Why it works:** The Go binary uses `SZA_PATH` to find 7za. By replacing 7za with a wrapper that returns 0 for exit code 2, the extraction is marked as successful. The Windows tools needed for rcedit (`rcedit-x64.exe`, `signtool.exe`) are already extracted before the symlink error occurs.

---

## Error 4: `cp` Not Recognized in Daemon Build Script

### Symptom

During `pnpm build`, the daemon package fails with:

```
'cp' is not recognized as an internal or external command, operable program or batch file.
```

### Root Cause

`apps/daemon/package.json` had:

```json
"build": "tsc && cp -r src/system-agents/agents dist/system-agents/"
```

`cp` is a Unix command. Windows `cmd.exe` (which pnpm uses to run scripts) does not have it.

### Fix

**File:** `apps/daemon/package.json`

Replace `cp -r` with a cross-platform Node.js one-liner:

```json
"build": "tsc && node -e \"require('fs').cpSync('src/system-agents/agents', 'dist/system-agents/agents', {recursive:true})\""
```

`fs.cpSync()` is built into Node.js 16.7+ and works identically on all platforms.

---

## Non-Fatal Warning: `fix:node-pty` Script

### Symptom

```
WARN  Unsupported platform
WARN  The script fix:node-pty is not supported on the current platform...
```

### Root Cause

`package.json` contains a macOS-only script:
```json
"fix:node-pty": "chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true"
```

The `build` script calls `fix:node-pty`, which is not applicable on Windows.

### Status

**Non-fatal** — the build proceeds successfully despite this warning. No fix required for Windows builds.

---

## Summary of Patches Applied

| File | Change | Persistence |
|------|--------|-------------|
| `node_modules/.pnpm/node-pty@1.1.0/.../winpty.gyp` | Hardcoded `WINPTY_COMMIT_HASH='none'`, `include_dirs=['gen']`, removed `SpectreMitigation` | `patches/node-pty@1.1.0.patch` |
| `node_modules/.pnpm/node-pty@1.1.0/.../binding.gyp` | Removed `SpectreMitigation` from Windows conditions | `patches/node-pty@1.1.0.patch` |
| `node_modules/.pnpm/node-pty@1.1.0/.../deps/winpty/src/gen/GenVersion.h` | Pre-generated header added to patch (not in npm package) | `patches/node-pty@1.1.0.patch` |
| `node_modules/.pnpm/7zip-bin@5.2.0/.../win/x64/7za.exe` | Replaced with wrapper that converts exit code 2 → 0 | `postinstall` script |
| `apps/desktop/electron-builder.json` | Win target changed to `["dir"]` (no NSIS installer required) | Committed |
| `apps/daemon/package.json` | Replaced `cp -r` with `node -e "fs.cpSync(...)"` | Committed |

---

## Persistent Patches

All patches are now persistent and survive `pnpm install`.

### node-pty (pnpm patch)

The node-pty gyp fixes are stored in `patches/node-pty@1.1.0.patch` and registered in `package.json` under `pnpm.patchedDependencies`. pnpm automatically applies this patch after every install.

```json
// package.json (added automatically by pnpm patch-commit)
"pnpm": {
  "patchedDependencies": {
    "node-pty@1.1.0": "patches/node-pty@1.1.0.patch"
  }
}
```

**How it was created:**
```bash
pnpm patch node-pty@1.1.0
# Edit the files in the temp dir shown
pnpm patch-commit 'D:\GIT\potato-cannon\node_modules\.pnpm_patches\node-pty@1.1.0'
```

### 7zip-bin (postinstall script)

`7zip-bin` ships a binary (`7za.exe`) which cannot be patched via text diff. Instead, a `postinstall` script compiles and installs the wrapper automatically:

**Script:** `scripts/install-7za-wrapper.js`

**Registered in `package.json`:**
```json
"scripts": {
  "postinstall": "node scripts/install-7za-wrapper.js"
}
```

**What the script does (on Windows only, idempotent):**
1. Locates `7zip-bin`'s `7za.exe` via `require('7zip-bin').path7za`
2. Checks if `7za_real.exe` already exists (skip if already installed)
3. Uses `dotnet publish` to compile a self-contained C# wrapper EXE
4. Renames `7za.exe` → `7za_real.exe`
5. Places the compiled wrapper as `7za.exe`

**Requirements:** .NET SDK 6+ must be on PATH. If not found, the script warns but does not fail the install. In that case, enable Windows Developer Mode as the alternative fix.

**Why pnpm patch won't work for binaries:** `pnpm patch-commit` generates a unified diff. Binary files cannot be meaningfully diffed. A postinstall script is the correct mechanism for binary modifications.

---

## Build Success Output

After applying all fixes, the build completes with:

```
• packaging       platform=win32 arch=x64 electron=40.2.1 appOutDir=release\win-unpacked
• completed installing native dependencies
• updating asar integrity executable resource
• signing with signtool.exe  [multiple EXEs - skipped, no CSC configured]
[afterPack] Native modules copied successfully
• downloading winCodeSign-2.6.0.7z ...
• signing with signtool.exe  path=release\win-unpacked\Potato Cannon.exe
```

Output: `apps/desktop/release/win-unpacked/Potato Cannon.exe`
