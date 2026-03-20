# Brainstorm Panel UX Improvements Design

Date: 2026-03-20

## Overview

Three focused UX improvements to unify the brainstorm panel with the ticket panel and move PM settings to the correct level of ownership.

---

## 1. Shared Draggable Panel Width

**Goal:** Brainstorm and ticket detail panels feel like the same conceptual UI element.

- Apply `useResizable` hook to `BrainstormDetailPanel` (same pattern as `TicketDetailPanel`)
- **Shared `localStorage` key** for panel width between both panels — dragging one sets the width for both
- Default width: 600px (current brainstorm fixed width)
- Min: 480px, Max: `window.innerWidth - 300px`
- Double-click snaps between default (600px) and 50vw
- Disabled on mobile (existing mobile overlay behavior unchanged)
- Add `.brainstorm-detail-panel__resize-handle` CSS mirroring ticket panel's resize handle styles

---

## 2. Title Badge Row Fix

**Goal:** Never replace the epic/brainstorm name with a status string.

**Current problem (`BrainstormDetailPanel.tsx` line ~205):**
```ts
{isEpicPm ? 'Epic — managed by PM' : (brainstormSheetBrainstormName || 'Brainstorm')}
```

**Fix:** Always render the actual name. Move status into the badge row:

- **Title line:** Always shows the brainstorm/epic name (editable inline as now)
- **Badge row:** Always shows a status badge:
  - `"Brainstorm"` badge (neutral style) when `status !== 'epic'`
  - `"Epic"` badge (colored per epic color) when `status === 'epic'`
  - PM mode badge (`passive` / `watching` / `executing`) shown alongside when `pmEnabled === true`
- Remove "Epic — managed by PM" text entirely — the PM mode badge communicates this

---

## 3. Per-Brainstorm PM Settings with Board Defaults

**Goal:** Each epic owns its own PM config. Board settings are just a seed for new epics.

### Board Settings Page (`BoardSettingsPage.tsx`)
- PM settings section stays, but is backed by **`localStorage` only** (no backend API)
- Label the section: *"Default PM settings — applied when enabling PM on a new epic"*
- Remove "Reset to Defaults" and "Save Board Settings" buttons; auto-save to `localStorage` on change
- No backend calls for board-level PM config

### Epic PM Settings (`EpicSettingsTab.tsx`)
- Per-brainstorm PM config stored in the brainstorm record in the database (already partially implemented)
- When PM mode is first enabled on an epic, seed from `localStorage` board defaults
- No "Reset to Defaults" button
- Save button persists to the brainstorm's own record

### Data Flow
```
BoardSettingsPage  →  localStorage (pmDefaults)
                              ↓ (seed on first enable)
EpicSettingsTab    →  brainstorm.pmConfig (database, per-epic)
Poller/Daemon      →  reads brainstorm.pmConfig only
```

---

## Files to Change

| File | Change |
|------|--------|
| `apps/frontend/src/components/brainstorm/BrainstormDetailPanel.tsx` | Apply `useResizable`, fix title, add Brainstorm badge |
| `apps/frontend/src/index.css` | Add resize handle styles for brainstorm panel |
| `apps/frontend/src/components/configure/BoardSettingsPage.tsx` | Switch PM section to localStorage, remove reset/save buttons |
| `apps/frontend/src/components/brainstorm/EpicSettingsTab.tsx` | Remove reset button, seed from localStorage on PM enable |

---

## Out of Scope

- Mobile layout changes
- Any new backend API endpoints
- Changing how the poller reads PM config (it already reads per-brainstorm)
