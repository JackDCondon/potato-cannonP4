# Change Default Workflow Implementation Plan

> **For Claude:** After human approval, use plan2beads to convert this plan to a beads epic, then use `superpowers-bd:subagent-driven-development` for parallel execution.

**Goal:** Allow users to change which workflow is the default for a project via a modal dialog in the project settings UI.

**Architecture:** Frontend-only change. The backend PATCH endpoint already supports `{ isDefault: true }` on workflows. We add a `useUpdateWorkflow` mutation hook, a `ChangeDefaultWorkflowDialog` modal component, and a "Change Default" button in `WorkflowsSection`.

**Tech Stack:** React 19, TanStack Query, Radix UI Dialog, Tailwind CSS, Lucide icons

**Key Decisions:**
- **Modal over inline toggle:** User requested the action feel deliberate — a modal with dropdown + warning communicates gravity better than a clickable star badge.
- **No backend changes:** The PATCH `/api/projects/:projectId/workflows/:workflowId` endpoint already handles `isDefault: true` (clears old default in a transaction). No API work needed.
- **Warning content:** "Future impact + deletion unlock" — tells users new tickets use the new default AND the old default can now be deleted. Balances informativeness without over-engineering.

---

## Task 1: Add `useUpdateWorkflow` mutation hook

**Depends on:** None
**Complexity:** simple
**Files:**
- Modify: `apps/frontend/src/hooks/queries.ts` (after `useCreateWorkflow` ending at line 578, before `useDeleteWorkflow` starting at line 580)

**Purpose:** The `api.updateWorkflow` function exists but has no TanStack Query mutation wrapper. We need one to call from the dialog.

**Step 1: Add the mutation hook**

In `apps/frontend/src/hooks/queries.ts`, after the `useCreateWorkflow` function (around line 578), add:

```typescript
export function useUpdateWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      projectId,
      workflowId,
      updates,
    }: {
      projectId: string
      workflowId: string
      updates: UpdateWorkflowInput
    }) => api.updateWorkflow(projectId, workflowId, updates),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ['workflows', projectId] })
    }
  })
}
```

Also add `UpdateWorkflowInput` to the imports from `@potato-cannon/shared` at the top of the file.

**Step 2: Verify typecheck**

Run: `cd apps/frontend && pnpm typecheck`
Expected: PASS (no type errors)

**Step 3: Commit**

```
git add apps/frontend/src/hooks/queries.ts
git commit -m "feat(ui): add useUpdateWorkflow mutation hook"
```

---

## Task 2: Create `ChangeDefaultWorkflowDialog` component

**Depends on:** Task 1
**Complexity:** standard
**Files:**
- Create: `apps/frontend/src/components/configure/ChangeDefaultWorkflowDialog.tsx`

**Purpose:** Modal dialog with a dropdown to select a new default workflow and a warning about the impact.

**Not In Scope:** Renaming workflows, changing templates, or any other workflow mutation.

**Step 1: Create the dialog component**

Create `apps/frontend/src/components/configure/ChangeDefaultWorkflowDialog.tsx`:

```typescript
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { ProjectWorkflow } from '@potato-cannon/shared'

interface ChangeDefaultWorkflowDialogProps {
  open: boolean
  workflows: ProjectWorkflow[]
  currentDefaultId: string
  isUpdating: boolean
  onCancel: () => void
  onConfirm: (workflowId: string) => void
}

export function ChangeDefaultWorkflowDialog({
  open,
  workflows,
  currentDefaultId,
  isUpdating,
  onCancel,
  onConfirm,
}: ChangeDefaultWorkflowDialogProps) {
  const [selectedId, setSelectedId] = useState<string>('')

  const nonDefaultWorkflows = workflows.filter(wf => wf.id !== currentDefaultId)

  const handleConfirm = () => {
    if (selectedId) {
      onConfirm(selectedId)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedId('')
          onCancel()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Default Workflow</DialogTitle>
          <DialogDescription>
            New tickets will use the selected workflow by default. The previous
            default workflow can then be deleted if no tickets reference it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary">
            New default workflow
          </label>
          <Select
            value={selectedId}
            onValueChange={setSelectedId}
            disabled={isUpdating}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a workflow" />
            </SelectTrigger>
            <SelectContent>
              {nonDefaultWorkflows.map(wf => (
                <SelectItem key={wf.id} value={wf.id}>
                  {wf.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isUpdating}>
            Cancel
          </Button>
          <Button
            disabled={isUpdating || !selectedId}
            onClick={handleConfirm}
          >
            {isUpdating ? 'Updating...' : 'Change Default'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

**Step 2: Verify typecheck**

Run: `cd apps/frontend && pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```
git add apps/frontend/src/components/configure/ChangeDefaultWorkflowDialog.tsx
git commit -m "feat(ui): add ChangeDefaultWorkflowDialog component"
```

---

## Task 3: Wire up "Change Default" button in WorkflowsSection

**Depends on:** Task 1, Task 2
**Complexity:** standard
**Files:**
- Modify: `apps/frontend/src/components/configure/SettingsSection.tsx` (add `action` prop)
- Modify: `apps/frontend/src/components/configure/WorkflowsSection.tsx`

**Purpose:** Add a "Change Default" button to the workflows section header and connect it to the new dialog.

**Step 1: Add `action` prop to SettingsSection**

`SettingsSection` does not currently have an `action` prop. Modify `apps/frontend/src/components/configure/SettingsSection.tsx` first so that Step 2's usage type-checks correctly.

Update the interface:

```typescript
interface SettingsSectionProps {
  title: string
  description: string
  children: React.ReactNode
  danger?: boolean
  action?: React.ReactNode
}
```

Update the destructured props:

```typescript
export function SettingsSection({
  title,
  description,
  children,
  danger = false,
  action,
}: SettingsSectionProps) {
```

Update the header `<div>` to render the action alongside the title:

```tsx
<div className="space-y-1">
  <div className="flex items-center justify-between gap-2">
    <h3 className={cn(
      'font-medium',
      danger ? 'text-accent-red' : 'text-text-primary'
    )}>
      {title}
    </h3>
    {action}
  </div>
  <p className="text-sm text-text-secondary">{description}</p>
</div>
```

**Step 2: Update WorkflowsSection**

In `apps/frontend/src/components/configure/WorkflowsSection.tsx`:

1. Add imports at the top:

```typescript
import { useUpdateWorkflow } from '@/hooks/queries'
import { ChangeDefaultWorkflowDialog } from './ChangeDefaultWorkflowDialog'
```

2. Inside the `WorkflowsSection` component, add state and handler after the existing state declarations:

```typescript
const updateWorkflow = useUpdateWorkflow()
const [showChangeDefault, setShowChangeDefault] = useState(false)

const currentDefault = workflows?.find(wf => wf.isDefault)
const canChangeDefault = (workflows?.length ?? 0) >= 2

function handleChangeDefault(workflowId: string) {
  updateWorkflow.mutate(
    { projectId: project.id, workflowId, updates: { isDefault: true } },
    {
      onSuccess: () => setShowChangeDefault(false),
      onError: (err) => console.error('change default workflow failed', err),
    },
  )
}
```

3. Update the `SettingsSection` to include a "Change Default" button. Change the opening tag from:

```tsx
<SettingsSection
  title="Workflows"
  description="Manage independent workflow boards for this project. Each workflow has its own ticket queue and kanban board."
>
```

To:

```tsx
<SettingsSection
  title="Workflows"
  description="Manage independent workflow boards for this project. Each workflow has its own ticket queue and kanban board."
  action={
    canChangeDefault ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowChangeDefault(true)}
      >
        Change Default
      </Button>
    ) : undefined
  }
>
```

4. Add the dialog before the closing `</SettingsSection>`, after the `DeleteWorkflowDialog`:

```tsx
{workflows && currentDefault && (
  <ChangeDefaultWorkflowDialog
    open={showChangeDefault}
    workflows={workflows}
    currentDefaultId={currentDefault.id}
    isUpdating={updateWorkflow.isPending}
    onCancel={() => setShowChangeDefault(false)}
    onConfirm={handleChangeDefault}
  />
)}
```

**Step 3: Verify typecheck**

Run: `cd apps/frontend && pnpm typecheck`
Expected: PASS

**Step 4: Manual verification**

1. Start dev server: `pnpm dev`
2. Navigate to a project's settings page
3. Verify "Change Default" button appears when 2+ workflows exist
4. Verify button is hidden when only 1 workflow exists
5. Click "Change Default" — modal opens with dropdown listing non-default workflows
6. Select a workflow and confirm — default badge moves to the new workflow
7. Verify the old default can now be deleted (trash icon enabled)

**Step 5: Commit**

```
git add apps/frontend/src/components/configure/WorkflowsSection.tsx
git add apps/frontend/src/components/configure/SettingsSection.tsx  # if modified
git commit -m "feat(ui): add Change Default button and wire up dialog in WorkflowsSection"
```

---

## Verification Record

### Plan Verification Checklist
| Check | Status | Notes |
|-------|--------|-------|
| Complete | ✓ | All requirements addressed — mutation hook, dialog component, and wiring with button visibility logic |
| Accurate | ✓ | All file paths verified, `api.updateWorkflow` and `UpdateWorkflowInput` confirmed |
| Commands valid | ✓ | `pnpm typecheck` and `pnpm dev` match project conventions |
| YAGNI | ✓ | Every task directly serves a stated requirement |
| Minimal | ✓ | Three focused tasks with no redundant steps |
| Not over-engineered | ✓ | Reuses existing PATCH endpoint, standard mutation hook and Radix dialog patterns |
| Key Decisions documented | ✓ | Three decisions with rationale (modal over toggle, no backend, warning content) |
| Context sections present | ✓ | Purpose on all tasks, Not In Scope on Task 2 |

### Rule-of-Five-Plans Passes
| Pass | Status | Changes | Summary |
|------|--------|---------|---------|
| Draft | CLEAN | 0 | All required sections present, three-task list covers every deliverable, dependencies correctly sketched |
| Feasibility | CLEAN | 0 | All file paths verified, API functions and types confirmed exported, commands valid, dependency graph acyclic |
| Completeness | CLEAN | 0 | All six requirements trace to tasks, all metadata sections present, manual verification included |
| Risk | CLEAN | 0 | No risks found — backend handles atomicity in a transaction, no migrations or breaking changes |
| Optimality | CLEAN | 0 | All three tasks directly serve the requirement, no excess abstractions or speculative code |
