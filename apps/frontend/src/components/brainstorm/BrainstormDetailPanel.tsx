import { useState, useCallback, useEffect, useRef } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { X, Lightbulb, Pencil, Check } from 'lucide-react'
import { api } from '@/api/client'
import { useAppStore } from '@/stores/appStore'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useBrainstorms } from '@/hooks/queries'
import { BrainstormChat } from './BrainstormChat'
import { BrainstormNewForm } from './BrainstormNewForm'
import { BrainstormArtifactsTab } from './BrainstormArtifactsTab'

export function BrainstormDetailPanel() {
  const brainstormSheetOpen = useAppStore((s) => s.brainstormSheetOpen)
  const brainstormSheetBrainstormId = useAppStore((s) => s.brainstormSheetBrainstormId)
  const brainstormSheetProjectId = useAppStore((s) => s.brainstormSheetProjectId)
  const brainstormSheetBrainstormName = useAppStore((s) => s.brainstormSheetBrainstormName)
  const brainstormSheetIsCreating = useAppStore((s) => s.brainstormSheetIsCreating)
  const closeBrainstormSheet = useAppStore((s) => s.closeBrainstormSheet)
  const openBrainstormSheet = useAppStore((s) => s.openBrainstormSheet)
  const currentProjectId = useAppStore((s) => s.currentProjectId)

  const queryClient = useQueryClient()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // Track the initial message so BrainstormChat can show a thinking indicator immediately
  const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(null)

  // Fetch full brainstorm data to get status and pmEnabled
  const brainstormsQuery = useBrainstorms(brainstormSheetProjectId)
  const brainstorm = brainstormsQuery.data?.find((b) => b.id === brainstormSheetBrainstormId)

  // Editable name state
  const [isEditingName, setIsEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Only show panel on board view and when viewing the same project
  const location = useLocation()
  const isOnBoardView = !!location.pathname.match(/^\/projects\/[^/]+\/(?:board|workflows\/[^/]+\/board)/)
  const isCorrectProject = currentProjectId === brainstormSheetProjectId

  const isOpen = brainstormSheetOpen && isOnBoardView && isCorrectProject

  // Start editing the name
  const handleStartEditName = useCallback(() => {
    setEditNameValue(brainstormSheetBrainstormName || 'Brainstorm')
    setIsEditingName(true)
  }, [brainstormSheetBrainstormName])

  // Focus the input when editing starts
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [isEditingName])

  // Save edited name
  const handleSaveName = useCallback(async () => {
    if (!brainstormSheetProjectId || !brainstormSheetBrainstormId) return
    const trimmed = editNameValue.trim()
    if (!trimmed || trimmed === brainstormSheetBrainstormName) {
      setIsEditingName(false)
      return
    }
    setIsSavingName(true)
    try {
      await api.updateBrainstorm(brainstormSheetProjectId, brainstormSheetBrainstormId, { name: trimmed })
      queryClient.invalidateQueries({ queryKey: ['brainstorms', brainstormSheetProjectId] })
      // Update the store so the header reflects the new name immediately
      openBrainstormSheet(brainstormSheetProjectId, brainstormSheetBrainstormId, trimmed)
    } catch (error) {
      console.error('Failed to rename brainstorm:', error)
    } finally {
      setIsSavingName(false)
      setIsEditingName(false)
    }
  }, [brainstormSheetProjectId, brainstormSheetBrainstormId, editNameValue, brainstormSheetBrainstormName, queryClient, openBrainstormSheet])

  // Cancel editing
  const handleCancelEditName = useCallback(() => {
    setIsEditingName(false)
    setEditNameValue('')
  }, [])

  // Handle escape key to close panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      // Don't close if a Radix dialog is open
      const openDialog = document.querySelector('[data-slot="dialog-content"][data-state="open"]')
      if (openDialog) return

      // If focus is in an input/textarea, blur it instead of closing
      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        activeElement.blur()
        return
      }

      closeBrainstormSheet()
    }

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, closeBrainstormSheet])

  const handleCreateBrainstorm = useCallback(async (message: string) => {
    if (!brainstormSheetProjectId) return
    setIsSubmitting(true)
    setCreateError(null)
    try {
      const response = await api.createBrainstorm(brainstormSheetProjectId, { initialMessage: message })
      const { id, name } = response.brainstorm

      // Track the initial message so chat can show thinking indicator immediately
      setPendingInitialMessage(message)

      // Invalidate the brainstorms list so it shows the new one
      queryClient.invalidateQueries({ queryKey: ['brainstorms', brainstormSheetProjectId] })

      // Transition from creation mode to chat mode
      openBrainstormSheet(brainstormSheetProjectId, id, name)
    } catch (error) {
      console.error('Failed to create brainstorm:', error)
      setCreateError(error instanceof Error ? error.message : 'Failed to create brainstorm')
    } finally {
      setIsSubmitting(false)
    }
  }, [brainstormSheetProjectId, queryClient, openBrainstormSheet])

  const handleDelete = useCallback(() => {
    if (!brainstormSheetProjectId) return
    queryClient.invalidateQueries({ queryKey: ['brainstorms', brainstormSheetProjectId] })
    closeBrainstormSheet()
  }, [brainstormSheetProjectId, queryClient, closeBrainstormSheet])

  const isExistingBrainstorm = !brainstormSheetIsCreating && !!brainstormSheetBrainstormId && !!brainstormSheetProjectId

  return (
    <div
      className="brainstorm-detail-panel"
      data-open={isOpen}
    >
      <div className="flex flex-col h-full w-[600px] max-w-[40vw]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 pb-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Lightbulb className="h-4 w-4 text-accent-yellow shrink-0" />
            {brainstormSheetIsCreating ? (
              <h2 className="text-text-primary text-lg font-semibold truncate">
                New Brainstorm
              </h2>
            ) : isEditingName ? (
              <div className="flex items-center gap-1 min-w-0 flex-1">
                <input
                  ref={nameInputRef}
                  type="text"
                  value={editNameValue}
                  onChange={(e) => setEditNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void handleSaveName() }
                    if (e.key === 'Escape') { e.preventDefault(); handleCancelEditName() }
                  }}
                  className="flex-1 bg-bg-secondary border border-border rounded px-2 py-0.5 text-lg font-semibold text-text-primary focus:outline-none focus:border-accent min-w-0"
                  disabled={isSavingName}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-text-muted hover:text-text-primary shrink-0"
                  onClick={() => void handleSaveName()}
                  disabled={isSavingName}
                >
                  <Check className="h-3.5 w-3.5" />
                  <span className="sr-only">Save name</span>
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0 flex-1 group">
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  <h2 className="text-text-primary text-lg font-semibold truncate">
                    {brainstorm?.status === 'epic' && brainstorm?.pmEnabled
                      ? 'Epic — managed by PM'
                      : brainstormSheetBrainstormName || 'Brainstorm'}
                  </h2>
                  {brainstorm?.status === 'epic' && brainstorm?.pmEnabled && (
                    <Badge variant="secondary" className="shrink-0">
                      Epic
                    </Badge>
                  )}
                </div>
                {isExistingBrainstorm && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-text-muted hover:text-text-primary shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleStartEditName}
                  >
                    <Pencil className="h-3 w-3" />
                    <span className="sr-only">Rename brainstorm</span>
                  </Button>
                )}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-text-muted hover:text-text-primary shrink-0"
            onClick={closeBrainstormSheet}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-h-0 mt-4">
          {brainstormSheetIsCreating ? (
            <>
              <BrainstormNewForm
                onSubmit={handleCreateBrainstorm}
                isSubmitting={isSubmitting}
              />
              {createError && (
                <div className="px-6 pb-4 text-sm text-destructive">
                  {createError}
                </div>
              )}
            </>
          ) : isExistingBrainstorm ? (
            <Tabs defaultValue="chat" className="flex flex-col flex-1 min-h-0">
              <TabsList className="mx-4 mb-2 w-auto self-start">
                <TabsTrigger value="chat">Chat</TabsTrigger>
                <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
              </TabsList>
              <TabsContent value="chat" className="flex-1 flex flex-col min-h-0 mt-0">
                <BrainstormChat
                  projectId={brainstormSheetProjectId}
                  brainstormId={brainstormSheetBrainstormId}
                  brainstormName={brainstormSheetBrainstormName || 'Brainstorm'}
                  initialMessage={pendingInitialMessage ?? undefined}
                  onDelete={handleDelete}
                />
              </TabsContent>
              <TabsContent value="artifacts" className="flex-1 min-h-0 mt-0">
                <BrainstormArtifactsTab
                  projectId={brainstormSheetProjectId}
                  brainstormId={brainstormSheetBrainstormId}
                />
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </div>
    </div>
  )
}
