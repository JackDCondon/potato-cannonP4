import { useState, useCallback, useRef, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useDroppable } from '@dnd-kit/core'
import { Folder, FolderOpen, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/api/client'
import { useAppStore } from '@/stores/appStore'
import { toast } from 'sonner'
import {
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Folder as FolderType } from '@potato-cannon/shared'

interface SidebarFolderGroupProps {
  folder: FolderType
  projectCount: number
  isCollapsed: boolean
  children: React.ReactNode
}

export function SidebarFolderGroup({
  folder,
  projectCount,
  isCollapsed,
  children,
}: SidebarFolderGroupProps) {
  const queryClient = useQueryClient()
  const toggleFolderCollapsed = useAppStore((s) => s.toggleFolderCollapsed)

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.name)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const { setNodeRef, isOver } = useDroppable({
    id: folder.id,
    data: { folderId: folder.id },
  })

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  const handleRenameSubmit = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (!trimmed || trimmed === folder.name) {
      setIsRenaming(false)
      setRenameValue(folder.name)
      return
    }

    if (trimmed.length > 100) {
      toast.error('Folder name must be 100 characters or less')
      return
    }

    try {
      await api.renameFolder(folder.id, trimmed)
      await queryClient.invalidateQueries({ queryKey: ['folders'] })
      setIsRenaming(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rename folder')
      setRenameValue(folder.name)
      setIsRenaming(false)
    }
  }, [renameValue, folder.id, folder.name, queryClient])

  const handleDelete = useCallback(async () => {
    try {
      await api.deleteFolder(folder.id)
      await queryClient.invalidateQueries({ queryKey: ['folders'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete folder')
    }
  }, [folder.id, queryClient])

  const FolderIcon = isCollapsed ? Folder : FolderOpen

  return (
    <div ref={setNodeRef}>
      <SidebarMenuItem
        className={cn(
          'transition-colors rounded-md',
          isOver && 'ring-2 ring-accent/50 bg-accent/5'
        )}
      >
        {isRenaming ? (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <FolderIcon className="h-4 w-4 shrink-0 text-text-muted" />
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleRenameSubmit()
                }
                if (e.key === 'Escape') {
                  setIsRenaming(false)
                  setRenameValue(folder.name)
                }
              }}
              className="flex-1 bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        ) : (
          <div className="flex items-center">
            <SidebarMenuButton
              onClick={() => toggleFolderCollapsed(folder.id)}
              className="flex-1"
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 shrink-0 transition-transform',
                  !isCollapsed && 'rotate-90'
                )}
              />
              <FolderIcon className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="flex-1 truncate">{folder.name}</span>
              <span className="text-xs text-text-muted shrink-0">
                {projectCount}
              </span>
            </SidebarMenuButton>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="p-1 rounded hover:bg-bg-hover text-text-muted opacity-0 group-hover/menu-item:opacity-100 transition-opacity shrink-0 mr-1">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="3" r="1.5" />
                    <circle cx="8" cy="8" r="1.5" />
                    <circle cx="8" cy="13" r="1.5" />
                  </svg>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setRenameValue(folder.name)
                    setIsRenaming(true)
                  }}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={projectCount > 0}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </SidebarMenuItem>

      {!isCollapsed && (
        <div className="ml-2">
          {children}
        </div>
      )}
    </div>
  )
}
