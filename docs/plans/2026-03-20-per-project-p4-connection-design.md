# Per-Project Perforce Connection Settings

**Date:** 2026-03-20
**Status:** Design approved

## Problem

The P4Provider currently relies entirely on `P4PORT` and `P4USER` environment variables inherited from the daemon process. Teams with multiple Perforce servers, or projects owned by different P4 users, have no way to configure connection details per project.

## Scope

Add `P4Port` and `P4User` as optional per-project settings, with a toggle to choose between environment variable inheritance (existing behaviour, the default) and project-specific values. Gated behind `vcsType === 'perforce'` in the UI. `P4Client` is intentionally excluded — workspace names are auto-generated as `potato-{slug}-{ticketId}` and owned by the daemon.

## Design

### 1. Data Model

Three new optional fields added to `Project` in both type locations:

**`packages/shared/src/types/project.types.ts`**
**`apps/daemon/src/types/config.types.ts`**

```typescript
p4UseEnvVars?: boolean   // undefined/true = inherit P4PORT/P4USER from env (default)
p4Port?: string          // e.g. "ssl:perforce.company.com:1666"
p4User?: string          // e.g. "jackd"
```

**No database migration required.** The `projects` table stores project settings as JSON; new optional fields serialize/deserialize automatically. Existing projects default to env-var behaviour (fields absent = `p4UseEnvVars` treated as `true`).

### 2. P4Provider

`P4ProviderConfig` gains two optional fields:

```typescript
export interface P4ProviderConfig {
  p4Stream: string
  agentWorkspaceRoot: string
  helixSwarmUrl?: string
  projectSlug: string
  p4Port?: string   // NEW
  p4User?: string   // NEW
}
```

A private helper prepends connection flags when the fields are present:

```typescript
private p4Args(cmd: string[]): string[] {
  return [
    ...(this.config.p4Port ? ['-p', this.config.p4Port] : []),
    ...(this.config.p4User ? ['-u', this.config.p4User] : []),
    ...cmd,
  ]
}
```

All `spawnSync`/`execSync` calls that invoke `p4` are updated to use `this.p4Args([...])`.

### 3. VCS Factory

`createVCSProvider` passes the new fields through only when `p4UseEnvVars` is falsy:

```typescript
return new P4Provider({
  p4Stream: project.p4Stream,
  agentWorkspaceRoot: project.agentWorkspaceRoot,
  helixSwarmUrl: project.helixSwarmUrl,
  projectSlug: project.slug,
  p4Port: project.p4UseEnvVars ? undefined : project.p4Port,
  p4User: project.p4UseEnvVars ? undefined : project.p4User,
})
```

When `p4UseEnvVars` is `true` (or absent), the fields are never forwarded even if stored — env vars win cleanly.

### 4. UI (ConfigurePage)

Inside the existing `vcsType === 'perforce'` block, below the current P4 Stream / Agent Workspace Root fields, add a new section:

**Toggle (saves immediately on change):**
```
[x] Use environment variables for P4PORT and P4USER
```

**When unchecked, reveal two fields (save on blur):**
```
P4 Port    [ ssl:perforce.company.com:1666 ]
           Perforce server address passed as -p to all p4 commands.

P4 User    [ jackd                         ]
           Perforce username passed as -u to all p4 commands.
```

New state:
```typescript
const [p4UseEnvVars, setP4UseEnvVars] = useState(true)
const [p4Port, setP4Port] = useState('')
const [p4User, setP4User] = useState('')
```

Load: `p4UseEnvVars` initialises to `project.p4UseEnvVars ?? true`.
Save pattern: identical to existing `p4Stream` / `agentWorkspaceRoot` blur handlers.

## Files to Change

| File | Change |
|------|--------|
| `packages/shared/src/types/project.types.ts` | Add `p4UseEnvVars?`, `p4Port?`, `p4User?` |
| `apps/daemon/src/types/config.types.ts` | Same three fields on daemon-side `Project` |
| `apps/daemon/src/services/session/vcs/p4.provider.ts` | Add fields to `P4ProviderConfig`, add `p4Args()` helper, update all `p4` invocations |
| `apps/daemon/src/services/session/vcs/factory.ts` | Pass new fields conditionally |
| `apps/frontend/src/components/configure/ConfigurePage.tsx` | Add toggle + conditional fields in perforce section |

## Out of Scope

- `P4Client` — auto-generated per ticket, not user-configurable
- `P4PASSWD` / credentials storage — out of scope for this iteration
- Global named connection profiles — deferred (YAGNI)
