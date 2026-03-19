# Epic Color & Icon Customization

**Date:** 2026-03-19
**Status:** Approved

## Overview

Each epic gets a unique color and icon from a curated palette, providing instant visual grouping of tickets on the board. Colors are auto-assigned at epic creation (random unused from palette) with manual override in a new Settings tab on the brainstorm detail panel.

## Data Model

### New columns on `brainstorms` table

```sql
ALTER TABLE brainstorms ADD COLUMN color TEXT;
ALTER TABLE brainstorms ADD COLUMN icon TEXT;
```

### Shared type extension

```typescript
interface Brainstorm {
  // ...existing fields
  color?: string | null
  icon?: string | null
}
```

### Curated Badge Palette (10 colors)

| Name    | Hex       |
|---------|-----------|
| Blue    | `#3b82f6` |
| Emerald | `#10b981` |
| Amber   | `#f59e0b` |
| Rose    | `#f43f5e` |
| Violet  | `#8b5cf6` |
| Cyan    | `#06b6d4` |
| Orange  | `#f97316` |
| Pink    | `#ec4899` |
| Lime    | `#84cc16` |
| Sky     | `#0ea5e9` |

### Curated Icon Subset (~25 icons)

From existing `ProjectIconPicker` categories: `code`, `terminal`, `git-branch`, `bug`, `wrench`, `package`, `rocket`, `layers`, `puzzle`, `database`, `server`, `cloud`, `palette`, `pen`, `briefcase`, `users`, `target`, `bookmark`, `flag`, `star`, `globe`, `shield`, `lock`, `lightbulb`, `zap`.

### Auto-assignment

When a brainstorm transitions to `status: 'epic'`:
1. Query `getUsedEpicColors(projectId)` — colors assigned to active epics in the project
2. Diff against the 10-color palette
3. Pick a random unused color (if all taken, pick randomly from full set)
4. Icon defaults to null (UI falls back to Layers)

## API & Store

- **No new routes.** Existing `PATCH /api/projects/:projectId/brainstorms/:brainstormId` handles `color` and `icon` updates.
- **`brainstorm.store.ts`**: Add `getUsedEpicColors(projectId)` helper. Existing `updateBrainstorm()` handles the new fields.
- **Migration**: Add `color` and `icon` columns in `migrations.ts`.
- **Auto-assignment hook**: In the brainstorm service, on `status → 'epic'` transition, auto-assign color.

## Frontend Components

### Modified Components

**`EpicBadge.tsx`**
- Accept `color` and `icon` props
- Resolve icon by name from curated subset (fallback: Layers)
- Apply color via inline `style={{ color }}` instead of hardcoded `text-indigo-400`
- Tooltip: epic name rendered in epic's color

**`TicketCard.tsx` / `TableView.tsx`**
- Pass `brainstorm.color` and `brainstorm.icon` through to EpicBadge (no logic changes)

**`BrainstormCard.tsx`**
- Epic cards use their color/icon instead of generic indigo Layers

**`BrainstormDetailPanel.tsx`**
- Header "Epic" pill badge uses epic's color as background
- Add third tab: **Settings** (gear icon), visible only when `status === 'epic'`

### New Component

**`EpicSettingsTab.tsx`** — three sections:

1. **Color** — grid of 10 swatches. Selected gets check mark. Click to PATCH update. Circular swatch pattern from ProjectColorPicker (no custom picker).
2. **Icon** — grid of ~25 icons. Selected highlighted in epic's color. Responsive grid pattern from ProjectIconPicker (smaller).
3. **PM Mode** — PM mode selector and alert toggles (relocated from BoardSettingsPage).

## Visual Touchpoints

| Location | Change |
|----------|--------|
| TicketCard (board) | Epic icon → chosen icon in epic's color |
| TicketCard tooltip | Epic name in epic's color |
| TableView | Colored epic icon |
| BrainstormCard | Epic cards show their icon/color |
| BrainstormDetailPanel header | "Epic" badge in epic's color |
| BrainstormDetailPanel Settings tab | Color/icon/PM config |

## Fallbacks

- No color set → `#818cf8` (indigo-400, backwards compatible)
- No icon set → Layers (current behavior)
- Fields only relevant when `status === 'epic'` — regular brainstorms unaffected
