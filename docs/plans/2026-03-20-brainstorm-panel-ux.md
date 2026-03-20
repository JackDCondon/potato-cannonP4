# Brainstorm Panel UX Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Unify the brainstorm and ticket detail panels with a shared draggable width, fix the epic title display, migrate board-level PM settings to localStorage defaults, and add an MCP tool for agents to set PM mode on an epic.

**Architecture:** The `useResizable` hook gains an optional `storageKey` to persist width to localStorage; both panels share the key `'potato-panel-width'`. Board PM settings move to localStorage only (no backend). Each epic's PM config remains in the database. A new `set_epic_pm_mode` MCP tool lets agents change PM mode using the session's `brainstormId` context.

**Tech Stack:** React 19, Zustand, TanStack Query, localStorage, TypeScript, Vitest, Node.js MCP tool layer (better-sqlite3)

**Key Decisions:**
- **Shared panel width key:** One `localStorage` key for both panels so they feel identical — user drags either panel and both remember the same width. Confirmed explicitly by user.
- **Board PM settings → localStorage only:** Removes backend dependency for board defaults. Board settings page auto-saves on change; no save/reset buttons in PM section. On epic PM first-enable, seed from localStorage.
- **Brainstorm badge always present:** Show "Brainstorm" badge for non-epics to mirror the "Epic" badge pattern — creates consistent visual language across all brainstorm states.
- **`set_epic_pm_mode` scope is session:** Uses `ctx.brainstormId` from session context so agents don't need to look up IDs. Optional `brainstormId` arg for overrides.
- **No backend changes for board defaults:** Board settings API endpoints (`getBoardSettings`, `updateBoardPmSettings`, `resetBoardPmSettings`) are removed from the frontend; daemon-side board settings routes are left intact but unused by this feature.

---

## Task 1: Add `storageKey` option to `useResizable` hook

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/hooks/use-resizable.ts:4-10` (options interface)
- Modify: `apps/frontend/src/hooks/use-resizable.ts:21-102` (hook implementation)
- Test: `apps/frontend/src/hooks/use-resizable.test.ts` (create if not exists)

**Purpose:** Persist panel width to localStorage so it survives page refreshes and is shared across panels using the same key.

**Not In Scope:** Changing existing callers — `TicketDetailPanel` will be updated in Task 2.

**Gotchas:** `useResizable` currently returns `defaultWidth` when `disabled=true` (line 98). The localStorage read must still respect the clamp bounds (min/maxWidth) in case the stored value is stale from a smaller window.

**Step 1: Write the failing test**

Create `apps/frontend/src/hooks/use-resizable.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResizable } from './use-resizable'

describe('useResizable – storageKey', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('reads initial width from localStorage when storageKey is provided', () => {
    localStorage.setItem('potato-panel-width', '550')
    const { result } = renderHook(() =>
      useResizable({
        minWidth: 480,
        maxWidth: () => 1200,
        defaultWidth: 480,
        snapWidth: () => 640,
        storageKey: 'potato-panel-width',
      })
    )
    expect(result.current.width).toBe(550)
  })

  it('falls back to defaultWidth when localStorage value is missing', () => {
    const { result } = renderHook(() =>
      useResizable({
        minWidth: 480,
        maxWidth: () => 1200,
        defaultWidth: 480,
        snapWidth: () => 640,
        storageKey: 'potato-panel-width',
      })
    )
    expect(result.current.width).toBe(480)
  })

  it('clamps stored value to minWidth', () => {
    localStorage.setItem('potato-panel-width', '100')
    const { result } = renderHook(() =>
      useResizable({
        minWidth: 480,
        maxWidth: () => 1200,
        defaultWidth: 480,
        snapWidth: () => 640,
        storageKey: 'potato-panel-width',
      })
    )
    expect(result.current.width).toBe(480)
  })

  it('does not use localStorage when storageKey is omitted', () => {
    localStorage.setItem('potato-panel-width', '999')
    const { result } = renderHook(() =>
      useResizable({
        minWidth: 480,
        maxWidth: () => 1200,
        defaultWidth: 480,
        snapWidth: () => 640,
      })
    )
    expect(result.current.width).toBe(480)
  })
})
```

**Step 2: Run test to verify failure**
```
cd apps/frontend && pnpm test src/hooks/use-resizable.test.ts
```
Expected: FAIL (storageKey not yet supported)

**Step 3: Implement**

In `apps/frontend/src/hooks/use-resizable.ts`:
```typescript
interface UseResizableOptions {
  minWidth: number
  maxWidth: () => number
  defaultWidth: number
  snapWidth: () => number
  disabled?: boolean
  storageKey?: string  // ADD THIS
}

// Inside the hook, replace `useState(defaultWidth)`:
const getInitialWidth = () => {
  if (storageKey) {
    const stored = localStorage.getItem(storageKey)
    if (stored) {
      const parsed = Number(stored)
      if (!isNaN(parsed)) {
        return Math.min(Math.max(parsed, minWidth), maxWidth())
      }
    }
  }
  return defaultWidth
}
const [width, setWidth] = useState(getInitialWidth)

// Wrap setWidth calls to also persist:
const setWidthAndPersist = useCallback((newWidth: number) => {
  setWidth(newWidth)
  if (storageKey) localStorage.setItem(storageKey, String(newWidth))
}, [storageKey])
```

Replace `setWidth(clamp(...))` with `setWidthAndPersist(clamp(...))` in the move handler, and `setWidth(...)` with `setWidthAndPersist(...)` in onDoubleClick.

**Step 4: Run test to verify pass**
```
cd apps/frontend && pnpm test src/hooks/use-resizable.test.ts
```
Expected: PASS (4 tests)

**Step 5: Commit**
```
git add apps/frontend/src/hooks/use-resizable.ts apps/frontend/src/hooks/use-resizable.test.ts
git commit -m "feat: add storageKey option to useResizable for localStorage persistence"
```

---

## Task 2: Apply shared resizable width to both detail panels

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx`
- Modify: `apps/frontend/src/components/ticket-detail/TicketDetailPanel.tsx:70-76` (add storageKey)
- Test: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.test.tsx`

**Purpose:** Both panels use the same `useResizable` call with `storageKey: 'potato-panel-width'` so dragging either one remembers the same width.

**Gotchas:** `BrainstormDetailPanel` currently has no resize handle at all. The resize handle must be the first child inside the panel div (left edge). `TicketDetailPanel` already imports `useResizable` at line 70 — just add `storageKey`.

**Step 1: Write failing tests**

In `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.test.tsx`, add:
```typescript
it('renders a resize handle when panel is open', () => {
  // render with a brainstorm in epic status
  // check for element with aria-label "Resize brainstorm detail panel"
  expect(screen.getByRole('separator', { name: /resize brainstorm detail panel/i })).toBeInTheDocument()
})

it('applies --panel-width CSS variable to panel element', () => {
  // check panel container has style containing --panel-width
  const panel = document.querySelector('.brainstorm-detail-panel')
  expect(panel?.getAttribute('style')).toContain('--panel-width')
})
```

**Step 2: Run to verify failure**
```
cd apps/frontend && pnpm test src/components/brainstorm/BrainstormDetailPanel.test.tsx
```
Expected: FAIL

**Step 3: Update TicketDetailPanel**

In `apps/frontend/src/components/ticket-detail/TicketDetailPanel.tsx` at the `useResizable` call (line 70):
```typescript
const { width, isDragging, handleProps } = useResizable({
  minWidth: 480,
  maxWidth: () => Math.max(window.innerWidth - 300, 480),
  defaultWidth: 480,
  snapWidth: () => window.innerWidth / 2,
  disabled: isMobile,
  storageKey: 'potato-panel-width',  // ADD THIS
})
```

**Step 4: Update BrainstormDetailPanel**

Add import and hook usage at the top of the component:
```typescript
import { useResizable } from '@/hooks/use-resizable'

// Inside component:
const { width, isDragging, handleProps } = useResizable({
  minWidth: 480,
  maxWidth: () => Math.max(window.innerWidth - 300, 480),
  defaultWidth: 600,  // design spec: 600px matches current fixed width
  snapWidth: () => window.innerWidth / 2,
  disabled: isMobile,
  storageKey: 'potato-panel-width',
})
```

Update the panel container div:
```tsx
<div
  className="brainstorm-detail-panel"
  data-open={brainstormSheetOpen}
  data-dragging={isDragging}
  style={{ '--panel-width': `${width}px` } as React.CSSProperties}
>
  <div
    className="brainstorm-detail-panel__resize-handle"
    {...handleProps}
    role="separator"
    aria-label="Resize brainstorm detail panel"
    aria-orientation="vertical"
  />
  {/* existing content */}
```

**Step 5: Run to verify pass**
```
cd apps/frontend && pnpm test src/components/brainstorm/BrainstormDetailPanel.test.tsx
```
Expected: PASS

**Step 6: Commit**
```
git add apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx apps/frontend/src/components/ticket-detail/TicketDetailPanel.tsx
git commit -m "feat: apply shared resizable width to brainstorm and ticket detail panels"
```

---

## Task 3: Update CSS for brainstorm panel resize handle

**Depends on:** Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/index.css:1016-1059` (brainstorm panel styles)

**Purpose:** Make the brainstorm panel use `var(--panel-width)` and add the resize handle indicator styles matching the ticket panel.

**Not In Scope:** Changing ticket panel CSS — it already works.

**Step 1: No test needed** (pure CSS, covered by visual inspection and existing render tests)

**Step 2: Update index.css**

Replace the brainstorm panel block (around line 1016):
```css
.brainstorm-detail-panel {
  height: 100%;
  border-left: 1px solid var(--color-border);
  background: var(--color-sidebar);
  flex-shrink: 0;
  overflow: hidden;
  transition: width 200ms ease-in-out;
  position: relative;
}

.brainstorm-detail-panel[data-open="true"] {
  width: var(--panel-width, 480px);
}

.brainstorm-detail-panel[data-open="false"] {
  width: 0;
}

.brainstorm-detail-panel[data-dragging="true"] {
  transition: none;
}

.brainstorm-detail-panel__resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brainstorm-detail-panel__resize-handle::before {
  content: '';
  width: 3px;
  height: 24px;
  border-radius: 2px;
  background: transparent;
  transition: background 150ms ease;
}

.brainstorm-detail-panel__resize-handle:hover::before {
  background: var(--color-text-muted);
}

.brainstorm-detail-panel:has(.brainstorm-detail-panel__resize-handle:hover) {
  border-left-color: var(--color-text-muted);
}
```

Remove the old `max-width: 40vw` rule — width is now controlled by `useResizable`.

**Step 3: Run full test suite to check no regressions**
```
cd apps/frontend && pnpm build:shared && pnpm test
```
Expected: all 35 test files pass

**Step 4: Commit**
```
git add apps/frontend/src/index.css
git commit -m "style: add resize handle CSS for brainstorm panel matching ticket panel"
```

---

## Task 4: Fix title display and add status badges in BrainstormDetailPanel

**Depends on:** Task 2
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx` (header section ~lines 200-225)
- Test: `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.test.tsx`

**Purpose:** Always show the real brainstorm/epic name as the title. Show a "Brainstorm" badge for non-epics, and keep the "Epic" badge (colored) + PM mode badge for epics.

**Gotchas:** Line ~205 currently does `{isEpicPm ? 'Epic — managed by PM' : name}`. Just always render `name`. The PM mode badge already exists at lines ~216-220 — keep it. Add a new "Brainstorm" badge that mirrors the Epic badge pattern but with neutral styling.

**Step 1: Write failing tests**

In `BrainstormDetailPanel.test.tsx`:
```typescript
it('shows brainstorm name as title, not "Epic — managed by PM", when PM-enabled', () => {
  // render with status='epic', pmEnabled=true, name='My Epic'
  expect(screen.getByText('My Epic')).toBeInTheDocument()
  expect(screen.queryByText(/managed by pm/i)).not.toBeInTheDocument()
})

it('shows "Brainstorm" badge when status is not epic', () => {
  // render with status='active', name='My Brainstorm'
  expect(screen.getByText('Brainstorm')).toBeInTheDocument()
})

it('shows "Epic" badge but not "Brainstorm" badge when status is epic', () => {
  // render with status='epic'
  expect(screen.getByText('Epic')).toBeInTheDocument()
  expect(screen.queryByText('Brainstorm')).not.toBeInTheDocument()
})
```

**Step 2: Run to verify failure**
```
cd apps/frontend && pnpm test src/components/brainstorm/BrainstormDetailPanel.test.tsx
```
Expected: FAIL

**Step 3: Implement**

In the header section of `BrainstormDetailPanel.tsx`, change the title line from:
```tsx
{isEpicPm ? 'Epic — managed by PM' : (brainstormSheetBrainstormName || 'Brainstorm')}
```
to:
```tsx
{brainstormSheetBrainstormName || 'Brainstorm'}
```

In the badge row, add a "Brainstorm" badge for non-epics:
```tsx
{/* Status badge — always shown */}
{isEpic ? (
  <span className={`epic-badge epic-badge--${brainstorm.color ?? 'default'}`}>Epic</span>
) : (
  <span className="epic-badge epic-badge--neutral">Brainstorm</span>
)}
{/* PM mode badge — only when PM-enabled */}
{isEpicPm && (
  <span className="pm-mode-badge">{brainstorm.pmMode ?? 'passive'}</span>
)}
```

Check existing badge styles in `index.css` to use the correct class names.

**Step 4: Run to verify pass**
```
cd apps/frontend && pnpm test src/components/brainstorm/BrainstormDetailPanel.test.tsx
```
Expected: PASS

**Step 5: Commit**
```
git add apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx
git commit -m "fix: always show epic name in header; add Brainstorm badge for non-epic state"
```

---

## Task 5: Migrate BoardSettingsPage PM section to localStorage

**Depends on:** None
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/lib/pm-storage.ts`
- Modify: `apps/frontend/src/components/configure/BoardSettingsPage.tsx:1-234`
- Test: `apps/frontend/src/components/configure/BoardSettingsPage.test.tsx` (create if not exists)

**Purpose:** Remove backend API calls for board-level PM settings. Auto-save to localStorage on change. Add a label explaining these are defaults for new epics.

**Not In Scope:** Removing the backend board settings endpoints from the daemon — they may be used elsewhere. Just stop calling them from the frontend.

**Gotchas:** `BoardSettingsPage` currently calls `api.getBoardSettings()` on mount and `api.updateBoardPmSettings()` / `api.resetBoardPmSettings()` on user action. All three calls must be replaced with localStorage reads/writes. The `DEFAULT_PM_CONFIG` from `@potato-cannon/shared` is the fallback when localStorage is empty.

**localStorage key and helpers live in `src/lib/pm-storage.ts`** (a new file — create it):
```typescript
// apps/frontend/src/lib/pm-storage.ts
import { DEFAULT_PM_CONFIG, type PmConfig } from '@potato-cannon/shared'

export const BOARD_PM_DEFAULTS_KEY = 'potato-board-pm-defaults'

export function loadBoardPmDefaults(): PmConfig {
  try {
    const raw = localStorage.getItem(BOARD_PM_DEFAULTS_KEY)
    if (raw) return { ...DEFAULT_PM_CONFIG, ...JSON.parse(raw) }
  } catch {}
  return DEFAULT_PM_CONFIG
}

export function saveBoardPmDefaults(config: PmConfig): void {
  localStorage.setItem(BOARD_PM_DEFAULTS_KEY, JSON.stringify(config))
}
```
Both `BoardSettingsPage` and `EpicSettingsTab` import from `@/lib/pm-storage` — no cross-component dependency.

**Step 1: Write failing tests**

Create `apps/frontend/src/components/configure/BoardSettingsPage.test.tsx`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BoardSettingsPage } from './BoardSettingsPage'
import { DEFAULT_PM_CONFIG } from '@potato-cannon/shared'

const STORAGE_KEY = 'potato-board-pm-defaults'

describe('BoardSettingsPage PM defaults', () => {
  beforeEach(() => localStorage.clear())

  it('loads DEFAULT_PM_CONFIG when localStorage is empty', () => {
    render(<BoardSettingsPage />)
    // PM mode should default to 'passive'
    expect(screen.getByRole('radio', { name: /passive/i })).toBeChecked()
  })

  it('loads saved config from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_PM_CONFIG, mode: 'watching' }))
    render(<BoardSettingsPage />)
    expect(screen.getByRole('radio', { name: /watching/i })).toBeChecked()
  })

  it('writes to localStorage when PM mode changes', async () => {
    render(<BoardSettingsPage />)
    fireEvent.click(screen.getByRole('radio', { name: /executing/i }))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
      expect(stored.mode).toBe('executing')
    })
  })

  it('does not render a Save Board Settings button', () => {
    render(<BoardSettingsPage />)
    expect(screen.queryByRole('button', { name: /save board settings/i })).not.toBeInTheDocument()
  })

  it('does not render a Reset to Defaults button', () => {
    render(<BoardSettingsPage />)
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
  })
})
```

**Step 2: Run to verify failure**
```
cd apps/frontend && pnpm test src/components/configure/BoardSettingsPage.test.tsx
```
Expected: FAIL

**Step 3: Create `src/lib/pm-storage.ts`** (see Gotchas section above for full file content)

**Step 4: Implement `BoardSettingsPage.tsx` changes**

```typescript
import { loadBoardPmDefaults, saveBoardPmDefaults } from '@/lib/pm-storage'
```

- Replace `useState` initialization from API call to `useState<PmConfig>(loadBoardPmDefaults)`
- Remove `useEffect` that calls `api.getBoardSettings()`
- On any PM setting change, call `saveBoardPmDefaults(updatedConfig)` inline
- Remove "Save Board Settings" button and "Reset to Defaults" button from the PM section
- Add a note above the PM section: `<p className="text-sm text-muted-foreground">These defaults are applied when enabling PM on a new epic.</p>`

**Step 5: Run to verify pass**
```
cd apps/frontend && pnpm test src/components/configure/BoardSettingsPage.test.tsx
```
Expected: PASS (5 tests)

**Step 6: Commit**
```
git add apps/frontend/src/lib/pm-storage.ts apps/frontend/src/components/configure/BoardSettingsPage.tsx apps/frontend/src/components/configure/BoardSettingsPage.test.tsx
git commit -m "feat: move board PM settings to localStorage; remove backend dependency"
```

---

## Task 6: Update EpicSettingsTab to seed PM config from localStorage defaults

**Depends on:** Task 5
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx`
- Test: `apps/frontend/src/components/brainstorm/EpicSettingsTab.test.tsx`

**Purpose:** When an epic's PM is first enabled (no existing `pmConfig`), seed the initial values from the `localStorage` board defaults instead of hardcoded defaults. Remove the "Reset to Defaults" button.

**Gotchas:** The `EpicSettingsTab` currently shows PM config only when `hasPmConfig = !!workflowId` (line 271). Seeding happens when the PM toggle is first turned on and `brainstorm.pmConfig` is null/undefined. Use `loadBoardPmDefaults()` from `@/lib/pm-storage` — do NOT import from `BoardSettingsPage.tsx`.

**Step 1: Write failing tests**

In `EpicSettingsTab.test.tsx`:
```typescript
it('seeds PM config from localStorage defaults when first enabling PM', async () => {
  localStorage.setItem('potato-board-pm-defaults', JSON.stringify({
    ...DEFAULT_PM_CONFIG,
    mode: 'watching',
    polling: { ...DEFAULT_PM_CONFIG.polling, intervalMinutes: 10 }
  }))
  // render with brainstorm that has no pmConfig yet
  // simulate clicking "Enable PM"
  // verify the mode selector shows 'watching'
  expect(screen.getByRole('radio', { name: /watching/i })).toBeChecked()
})

it('does not render a Reset to Defaults button', () => {
  render(<EpicSettingsTab brainstorm={epicBrainstorm} />)
  expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
})
```

**Step 2: Run to verify failure**
```
cd apps/frontend && pnpm test src/components/brainstorm/EpicSettingsTab.test.tsx
```
Expected: FAIL

**Step 3: Implement**

In `EpicSettingsTab.tsx`, when PM is first enabled:
```typescript
import { loadBoardPmDefaults } from '@/lib/pm-storage'

// When enabling PM for first time (pmConfig is null/undefined):
const seedConfig = loadBoardPmDefaults()
// use seedConfig as initial state for pmMode, pmAlerts, pmPolling
```

Remove the "Reset to Defaults" button and its handler.

**Step 4: Run to verify pass**
```
cd apps/frontend && pnpm test src/components/brainstorm/EpicSettingsTab.test.tsx
```
Expected: PASS

**Step 5: Commit**
```
git add apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx
git commit -m "feat: seed epic PM config from board localStorage defaults; remove reset button"
```

---

## Task 7: Add `set_epic_pm_mode` MCP tool

**Depends on:** None
**Complexity:** standard
**Files:**
- Modify: `packages/shared/src/types/brainstorm.types.ts` (add `pmConfig?: PmConfig | null` to `Brainstorm` interface)
- Modify: `apps/daemon/src/stores/migrations.ts` (add V27 migration)
- Modify: `apps/daemon/src/stores/brainstorm.store.ts` (add `updateBrainstormPmConfig`, update `BrainstormRow`/mapper)
- Modify: `apps/daemon/src/mcp/tools/epic.tools.ts`
- Modify: `apps/daemon/src/mcp/tools/index.ts` (verify tool is exported — it should already be via epicTools)
- Test: `apps/daemon/src/mcp/tools/epic.tools.test.ts` (create)

**Purpose:** Allow agents to change PM mode on an epic ("Please watch this for me" → `set_epic_pm_mode({ mode: 'watching' })`). Uses session's `ctx.brainstormId` so the agent doesn't need to look up IDs.

**Gotchas:**
- The `brainstorms` table has `pm_enabled INTEGER` (added in V22) but **no `pm_config` column** — a V27 migration must add it before the store function will work.
- `ctx.brainstormId` is available from the session context (confirmed in `get_epic_status` handler line 115).
- Setting mode to `'passive'` should set `pmEnabled = false`.
- Current schema is V26; the new migration is V27.

**Step 1: Add V27 migration to `migrations.ts`**

In `apps/daemon/src/stores/migrations.ts`:

1. Update the `CURRENT_SCHEMA_VERSION` constant from `26` to `27`.

2. Add the migration block inside the `if (version < N)` chain (after the `if (version < 26)` block):
```typescript
if (version < 27) {
  migrateV27(db)
}
```
**Do NOT** add `db.pragma('user_version = 27')` inside the block — the final line of `runMigrations` sets the version once using `CURRENT_SCHEMA_VERSION`. Only updating the constant is needed.

3. Add the migration function:
```typescript
function migrateV27(db: Database.Database): void {
  db.exec(`ALTER TABLE brainstorms ADD COLUMN pm_config TEXT`)
  console.log('[migrateV27] Added pm_config column to brainstorms table')
}
```

**Step 2: Update shared `Brainstorm` type**

In `packages/shared/src/types/brainstorm.types.ts`, add `pmConfig` to the `Brainstorm` interface:
```typescript
pmConfig?: PmConfig | null
```
Import `PmConfig` from `@potato-cannon/shared`'s own types if needed (check existing imports). Then run `pnpm build:shared` to verify compilation.

**Step 2b: Add `updateBrainstormPmConfig` to brainstorm store**

Read `apps/daemon/src/stores/brainstorm.store.ts` and verify the column names (`pm_enabled`, `id`), then add:
```typescript
export function updateBrainstormPmConfig(
  brainstormId: string,
  update: { pmEnabled: boolean; pmConfig: PmConfig }
): void {
  db.prepare(
    'UPDATE brainstorms SET pm_enabled = ?, pm_config = ? WHERE id = ?'
  ).run(update.pmEnabled ? 1 : 0, JSON.stringify(update.pmConfig), brainstormId)
}
```
Also update `BrainstormRow` and the `mapRow` function to include `pm_config TEXT | null` → `pmConfig: PmConfig | null`.

**Step 3: Write failing test**

Create `apps/daemon/src/mcp/tools/epic.tools.test.ts`:
```typescript
import { describe, it, expect, mock } from 'node:test'
// mock getBrainstorm and updateBrainstormPmConfig
// call epicHandlers.set_epic_pm_mode with ctx = { brainstormId: 'b1', projectId: 'p1' }
//   and args = { mode: 'watching' }
// assert updateBrainstormPmConfig called with { pmEnabled: true, pmConfig: { ...mode: 'watching' } }

// test mode='passive' → updateBrainstormPmConfig called with pmEnabled=false
// test missing brainstormId returns error text
```

**Step 4: Run to verify failure**
```
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/mcp/tools/epic.tools.test.js
```
Expected: FAIL

**Step 6: Add tool definition to epicTools array**

In `apps/daemon/src/mcp/tools/epic.tools.ts`:
```typescript
{
  name: 'set_epic_pm_mode',
  description: 'Set the PM monitoring mode for the current epic. Use "passive" to disable monitoring, "watching" to enable alerts, "executing" to enable autonomous advancement.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['passive', 'watching', 'executing'],
        description: 'The PM mode to set.',
      },
      brainstormId: {
        type: 'string',
        description: 'Epic/brainstorm ID. Defaults to the current session context.',
      },
    },
    required: ['mode'],
  },
  scope: 'session',
},
```

**Step 7: Add handler**

Note: `getBrainstorm` throws when the brainstorm is not found (it does not return null). Use try/catch rather than a null-guard.

```typescript
set_epic_pm_mode: async (ctx, args) => {
  const brainstormId = (args.brainstormId as string | undefined) ?? ctx.brainstormId
  const mode = args.mode as 'passive' | 'watching' | 'executing'

  if (!brainstormId) {
    return { content: [{ type: 'text', text: 'Error: no brainstormId in context or args' }] }
  }

  let brainstorm
  try {
    brainstorm = await getBrainstorm(ctx.projectId, brainstormId)
  } catch {
    return { content: [{ type: 'text', text: `Error: epic '${brainstormId}' not found` }] }
  }

  const pmEnabled = mode !== 'passive'
  const existing = brainstorm.pmConfig ?? DEFAULT_PM_CONFIG
  const updatedPmConfig = { ...existing, mode }

  updateBrainstormPmConfig(brainstormId, { pmEnabled, pmConfig: updatedPmConfig })

  return {
    content: [{ type: 'text', text: `PM mode for epic '${brainstorm.name}' set to '${mode}'` }],
  }
},
```

**Step 8: Run to verify pass**
```
cd apps/daemon && pnpm build && node --experimental-test-module-mocks --test dist/mcp/tools/epic.tools.test.js
```
Expected: PASS

**Step 9: Commit**
```
git add apps/daemon/src/stores/migrations.ts apps/daemon/src/stores/brainstorm.store.ts apps/daemon/src/mcp/tools/epic.tools.ts apps/daemon/src/mcp/tools/epic.tools.test.ts
git commit -m "feat: add set_epic_pm_mode MCP tool; add pm_config column to brainstorms (V27)"
```

---

## Task 8: Full test suite verification

**Depends on:** Tasks 1–7
**Complexity:** simple
**Files:** None (verification only)

**Step 1: Build shared package**
```
cd apps/daemon && pnpm build:shared 2>/dev/null; cd ../../
pnpm build:shared
```

**Step 2: Run all tests**
```
pnpm test
```
Expected: all test files pass, no regressions

**Step 3: TypeScript check**
```
pnpm typecheck
```
Expected: no errors

**Step 4: Commit if any fixes needed, then final commit**
```
git commit -m "chore: verify all tests pass after brainstorm panel UX changes"
```

---

## Verification Record

| Pass | Verdict | Notes |
|------|---------|-------|
| Plan Verification Checklist | PASS (after fixes) | Fixed: defaultWidth 600px for brainstorm; daemon test commands use `pnpm build && node --experimental-test-module-mocks --test dist/...`; Task 5 exports `BOARD_PM_DEFAULTS_KEY`; Task 7 step 1 uses `grep`-equivalent instead of bash |
| Draft | PASS | All required sections present. Minor: Task 7 test is pseudocode; Task 8 Depends-on is inline text |
| Feasibility | PASS (after fixes) | Fixed: V27 migration added to create `pm_config TEXT` column on `brainstorms` table; `getBrainstorm` signature confirmed; `DEFAULT_PM_CONFIG` exists in shared |
| Completeness | PASS (with note) | All 3 design features fully traced. MCP tool (Task 7) is user-requested but post-dates the design doc — intentional scope addition |
| Risk | PASS (after fixes) | Fixed: `CURRENT_SCHEMA_VERSION` must be updated to 27; `getBrainstorm` throws (not null), handler uses try/catch |
| Optimality | PASS (after fixes) | Fixed: `BOARD_PM_DEFAULTS_KEY` and helpers moved to `src/lib/pm-storage.ts`; shared `Brainstorm` type updated in Task 7 |
