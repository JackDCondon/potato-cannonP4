# [Bug] Windows Build Fails: Multiple Issues with node-pty and electron-builder

**Platform:** Windows 11 (also likely Windows 10)
**Component:** Desktop app build from source
**Severity:** Blocker — cannot build on Windows without manual patches

---

## Description

Building the potato-cannon desktop app from source on Windows fails due to three separate issues. None of these are present on macOS/Linux. The errors affect Windows developers who want to build from source and would need to be fixed before a Windows CI/release pipeline can work.

---

## Environment

- OS: Windows 11 Pro 10.0.26200
- Node.js: (via pnpm)
- pnpm: workspace monorepo
- Visual Studio Build Tools 2022 (required for native modules)
- Electron: 40.2.1

---

## Steps to Reproduce

```bash
git clone <repo>
cd potato-cannon
pnpm install
pnpm build
```

---

## Errors

### Error 1: `GetCommitHash.bat` not recognized

During `pnpm build`, the `@electron/rebuild` step for `node-pty` fails:

```
'GetCommitHash.bat' is not recognized as an internal or external command, operable program or batch file.
```

**Root cause:** `node-pty@1.1.0`'s bundled `winpty` dependency has a `winpty.gyp` file that uses GYP's `<!(cmd /c "cd shared && GetCommitHash.bat")` syntax to run a batch file at build configuration time. On Windows, `node-gyp` runs this from a working directory where the batch file cannot be found.

**Workaround:** Manually edit `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/deps/winpty/src/winpty.gyp`:

Change:
```gyp
'variables': {
    'WINPTY_COMMIT_HASH%': '<!(cmd /c "cd shared && GetCommitHash.bat")',
},
'include_dirs': [
    '<!(cmd /c "cd shared && UpdateGenVersion.bat <(WINPTY_COMMIT_HASH)")',
]
```

To:
```gyp
'variables': {
    'WINPTY_COMMIT_HASH%': 'none',
},
'include_dirs': [
    'gen',
]
```

(`gen/GenVersion.h` already exists in the winpty source tree.)

---

### Error 2: Spectre-mitigated libraries required but not installed

After fixing Error 1, the build fails with an MSVC error about Spectre mitigation libraries:

**Root cause:** Both `winpty.gyp` and `node-pty/binding.gyp` specify `'SpectreMitigation': 'Spectre'` in `msvs_configuration_attributes`. This requires the optional **"MSVC v143 - VS 2022 C++ Spectre-mitigated libs"** Visual Studio component, which most developers don't have installed.

**Workaround:** Remove all `msvs_configuration_attributes: { SpectreMitigation: 'Spectre' }` blocks from:
- `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/deps/winpty/src/winpty.gyp`
- `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/binding.gyp`

---

### Error 3: `winCodeSign` extraction fails — symbolic link privilege error (Blocker)

After the native module compilation succeeds, `electron-builder` fails during packaging:

```
• downloading url=https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z size=5.6 MB parts=1
⨯ cannot execute cause=exit status 2
errorOut=ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

This error appears **4 times** (with 3 retries) and is fatal.

**Root cause:** `winCodeSign-2.6.0.7z` contains macOS symlinks (`darwin/10.12/lib/libcrypto.dylib → libcrypto.1.0.0.dylib`, etc.). Windows requires `SeCreateSymbolicLinkPrivilege` to create symlinks — only available with **Administrator** rights or **Windows Developer Mode** enabled. 7-Zip exits with code 2 when it can't create the symlinks, which `app-builder.exe` (electron-builder's Go binary) treats as a fatal error.

The Windows tools that are actually needed (`rcedit-x64.exe`, `signtool.exe`) ARE extracted successfully before the error, but app-builder discards them because 7za returned a non-zero exit code.

**Workaround (requires .NET SDK):** Replace `node_modules/.pnpm/7zip-bin@5.2.0/node_modules/7zip-bin/win/x64/7za.exe` with a wrapper that suppresses exit code 2:

1. Rename `7za.exe` → `7za_real.exe` in that directory
2. Compile this C# program as `7za.exe` (self-contained win-x64):

```csharp
// 7za wrapper: suppresses exit code 2 from macOS symlink failures in winCodeSign
using System;
using System.Diagnostics;
using System.IO;

var exeDir = Path.GetDirectoryName(System.Environment.ProcessPath) ?? "";
var real7za = Path.Combine(exeDir, "7za_real.exe");

var psi = new ProcessStartInfo { FileName = real7za, UseShellExecute = false };
foreach (var arg in args) psi.ArgumentList.Add(arg);

var proc = Process.Start(psi)!;
proc.WaitForExit();

// 7za exit code 2 occurs when macOS symlinks in winCodeSign can't be created
// on Windows without Developer Mode. The needed Windows tools ARE extracted.
if (proc.ExitCode == 2) return 0;
return proc.ExitCode;
```

**Alternative workaround (no compilation needed):** Enable Windows Developer Mode:
- Settings → System → For developers → Developer Mode → On
- Then re-run the build. 7za will be able to create symlinks.

---

### Error 4: `cp` not recognized in daemon build

```
'cp' is not recognized as an internal or external command, operable program or batch file.
```

**Root cause:** `apps/daemon/package.json`'s build script uses `cp -r` which is a Unix-only command.

**Fix:** Replace with a cross-platform Node.js equivalent in `apps/daemon/package.json`:

```json
"build": "tsc && node -e \"require('fs').cpSync('src/system-agents/agents', 'dist/system-agents/agents', {recursive:true})\""
```

---

## Fixes Applied in This Repo

These fixes have already been applied and are persistent (survive `pnpm install`):

### node-pty — `pnpm patch`

A patch file at `patches/node-pty@1.1.0.patch` is registered in `package.json` under `pnpm.patchedDependencies` and auto-applied on every install. Fixes both `GetCommitHash.bat` and `SpectreMitigation`.

### 7zip-bin — `postinstall` script

`scripts/install-7za-wrapper.js` runs automatically after `pnpm install`. It compiles a C# wrapper that suppresses 7za exit code 2 and installs it in place. Requires .NET SDK 6+; falls back gracefully with a warning if not found.

---

## Proposed Upstream Fixes

1. **For node-pty (`GetCommitHash.bat` + `SpectreMitigation`):**
   - Upstream fix to `node-pty@1.1.0` / winpty bundled dependency
   - Remove `SpectreMitigation` from gyp files or make it conditional on MSVC component availability

2. **For winCodeSign symlink issue:**
   - The `winCodeSign-2.6.0.7z` archive should be repackaged without macOS symlinks
   - This is an upstream issue in [electron-userland/electron-builder-binaries](https://github.com/electron-userland/electron-builder-binaries)
   - Alternatively, electron-builder could pass `7za -snld` (skip symlink creation) to avoid the failure

3. **For `apps/daemon/package.json` `cp -r`:**
   - Already fixed in this repo by replacing with `fs.cpSync()`
   - Any other scripts using `cp`, `rm`, `chmod`, `mv` etc. will have the same problem on Windows

4. **For the root `package.json` `fix:node-pty` script:**
   - The `build` script calls `fix:node-pty` which is a no-op on Windows but produces a `WARN Unsupported platform` message
   - Should be guarded with a platform check

---

## References

- `app-builder.exe` source: `github.com/develar/app-builder/pkg/rcedit/rcedit.go`
- The `SZA_PATH` env var is set by `builder-util`'s `executeAppBuilder()` and points to the bundled `7zip-bin`
- winCodeSign archive: https://github.com/electron-userland/electron-builder-binaries/releases/tag/winCodeSign-2.6.0
- Windows symlink docs: https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/create-symbolic-links
