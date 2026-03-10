import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsSection } from './SettingsSection'
import { ProjectIconPicker } from './ProjectIconPicker'
import { ProjectColorPicker } from './ProjectColorPicker'
import { WorkflowsSection } from './WorkflowsSection'
import { useProjects, useTemplates, useUpdateProject, useDeleteProject } from '@/hooks/queries'
import { useTemplateStatus } from '@/hooks/useTemplateStatus'
import { ChangelogModal } from '@/components/ChangelogModal'
import { api } from '@/api/client'

// Validate branch prefix (git-safe characters only)
function isValidBranchPrefix(prefix: string): boolean {
  if (!prefix) return true
  return /^[a-zA-Z0-9/_-]+$/.test(prefix)
}

// Validate P4 stream (must start with //)
function isValidP4Stream(stream: string): boolean {
  if (!stream) return true
  return stream.startsWith('//')
}

// Validate URL format (http/https)
function isValidUrl(url: string): boolean {
  if (!url) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

interface ConfigurePageProps {
  projectId: string
}

export function ConfigurePage({ projectId }: ConfigurePageProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: projects } = useProjects()
  const { data: templates } = useTemplates()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()

  const project = projects?.find(p => p.id === projectId)

  // Local state for form fields
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('package')
  const [color, setColor] = useState<string | undefined>(undefined)
  const [selectedTemplate, setSelectedTemplate] = useState<string>('')
  const [branchPrefix, setBranchPrefix] = useState('potato')
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(null)

  // Perforce fields
  const [p4Stream, setP4Stream] = useState('')
  const [p4StreamError, setP4StreamError] = useState<string | null>(null)
  const [agentWorkspaceRoot, setAgentWorkspaceRoot] = useState('')
  const [agentWorkspaceRootError, setAgentWorkspaceRootError] = useState<string | null>(null)
  const [helixSwarmUrl, setHelixSwarmUrl] = useState('')
  const [helixSwarmUrlError, setHelixSwarmUrlError] = useState<string | null>(null)

  // Dialog states
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [pendingTemplate, setPendingTemplate] = useState<string>('')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isChangingTemplate, setIsChangingTemplate] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const { data: templateStatus } = useTemplateStatus(projectId)

  // Sync local state from project data
  useEffect(() => {
    if (project) {
      setName(project.displayName || project.id)
      setIcon(project.icon || 'package')
      setColor(project.color)
      setSelectedTemplate(project.template?.name || '')
      setBranchPrefix(project.branchPrefix || 'potato')
      setBranchPrefixError(null)
      // P4 fields — pre-fill from project data; suggestedP4Stream populates stream if not yet set
      const streamValue = project.p4Stream || project.suggestedP4Stream || ''
      setP4Stream(streamValue)
      setP4StreamError(null)
      setAgentWorkspaceRoot(project.agentWorkspaceRoot || '')
      setAgentWorkspaceRootError(null)
      setHelixSwarmUrl(project.helixSwarmUrl || '')
      setHelixSwarmUrlError(null)
    }
  }, [project])

  // Save name on blur
  const handleNameBlur = useCallback(() => {
    if (!project) return
    const newName = name.trim()
    if (newName && newName !== (project.displayName || project.id)) {
      updateProject.mutate({ id: projectId, updates: { displayName: newName } })
    }
  }, [name, project, projectId, updateProject])

  // Save name on Enter
  const handleNameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  // Handle branch prefix change with validation
  const handleBranchPrefixChange = useCallback((value: string) => {
    setBranchPrefix(value)
    if (!isValidBranchPrefix(value)) {
      setBranchPrefixError('Branch prefix can only contain letters, numbers, hyphens, underscores, and forward slashes')
    } else {
      setBranchPrefixError(null)
    }
  }, [])

  // Save branch prefix on blur
  const handleBranchPrefixBlur = useCallback(() => {
    if (!project) return
    if (branchPrefixError) return // Don't save if invalid
    const newPrefix = branchPrefix.trim() || 'potato'
    if (newPrefix !== (project.branchPrefix || 'potato')) {
      updateProject.mutate({ id: projectId, updates: { branchPrefix: newPrefix } })
    }
  }, [branchPrefix, branchPrefixError, project, projectId, updateProject])

  // Save branch prefix on Enter
  const handleBranchPrefixKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  // Handle P4 stream change with validation
  const handleP4StreamChange = useCallback((value: string) => {
    setP4Stream(value)
    if (!isValidP4Stream(value)) {
      setP4StreamError('P4 Stream must start with //')
    } else {
      setP4StreamError(null)
    }
    // Validate agent workspace root when stream changes
    if (value && !agentWorkspaceRoot) {
      setAgentWorkspaceRootError('Agent Workspace Root is required when P4 Stream is set')
    } else {
      setAgentWorkspaceRootError(null)
    }
  }, [agentWorkspaceRoot])

  // Save P4 stream on blur
  const handleP4StreamBlur = useCallback(() => {
    if (!project) return
    if (p4StreamError) return
    const newStream = p4Stream.trim()
    if (newStream !== (project.p4Stream || project.suggestedP4Stream || '')) {
      updateProject.mutate({ id: projectId, updates: { p4Stream: newStream || undefined } })
    }
  }, [p4Stream, p4StreamError, project, projectId, updateProject])

  const handleP4StreamKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  // Handle agent workspace root change with validation
  const handleAgentWorkspaceRootChange = useCallback((value: string) => {
    setAgentWorkspaceRoot(value)
    if (p4Stream && !value) {
      setAgentWorkspaceRootError('Agent Workspace Root is required when P4 Stream is set')
    } else {
      setAgentWorkspaceRootError(null)
    }
  }, [p4Stream])

  // Save agent workspace root on blur
  const handleAgentWorkspaceRootBlur = useCallback(() => {
    if (!project) return
    if (agentWorkspaceRootError) return
    const newRoot = agentWorkspaceRoot.trim()
    if (newRoot !== (project.agentWorkspaceRoot || '')) {
      updateProject.mutate({ id: projectId, updates: { agentWorkspaceRoot: newRoot || undefined } })
    }
  }, [agentWorkspaceRoot, agentWorkspaceRootError, project, projectId, updateProject])

  const handleAgentWorkspaceRootKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  // Handle Helix Swarm URL change with validation
  const handleHelixSwarmUrlChange = useCallback((value: string) => {
    setHelixSwarmUrl(value)
    if (!isValidUrl(value)) {
      setHelixSwarmUrlError('Helix Swarm URL must be a valid http or https URL')
    } else {
      setHelixSwarmUrlError(null)
    }
  }, [])

  // Save Helix Swarm URL on blur
  const handleHelixSwarmUrlBlur = useCallback(() => {
    if (!project) return
    if (helixSwarmUrlError) return
    const newUrl = helixSwarmUrl.trim()
    if (newUrl !== (project.helixSwarmUrl || '')) {
      updateProject.mutate({ id: projectId, updates: { helixSwarmUrl: newUrl || undefined } })
    }
  }, [helixSwarmUrl, helixSwarmUrlError, project, projectId, updateProject])

  const handleHelixSwarmUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  // Save icon immediately on click
  const handleIconChange = useCallback((newIcon: string) => {
    setIcon(newIcon)
    updateProject.mutate({ id: projectId, updates: { icon: newIcon } })
  }, [projectId, updateProject])

  // Save color immediately on click
  const handleColorChange = useCallback((newColor: string) => {
    setColor(newColor)
    updateProject.mutate({ id: projectId, updates: { color: newColor } })
  }, [projectId, updateProject])

  // Template change with confirmation
  const handleTemplateChange = useCallback((templateName: string) => {
    if (templateName !== selectedTemplate) {
      setPendingTemplate(templateName)
      setShowTemplateDialog(true)
    }
  }, [selectedTemplate])

  const confirmTemplateChange = useCallback(async () => {
    setIsChangingTemplate(true)
    try {
      await api.setProjectTemplate(projectId, pendingTemplate)
      setSelectedTemplate(pendingTemplate)
      // Invalidate queries to refresh project data
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await queryClient.invalidateQueries({ queryKey: ['projectPhases', projectId] })
      setShowTemplateDialog(false)
    } catch (error) {
      console.error('Failed to change template:', error)
    } finally {
      setIsChangingTemplate(false)
    }
  }, [projectId, pendingTemplate, queryClient])

  // Delete with confirmation
  const confirmDelete = useCallback(async () => {
    setIsDeleting(true)
    try {
      await deleteProject.mutateAsync(projectId)
      navigate({ to: '/' })
    } catch (error) {
      console.error('Failed to delete project:', error)
      setIsDeleting(false)
    }
  }, [projectId, deleteProject, navigate])

  if (!project) {
    return (
      <div className="p-6">
        <p className="text-text-secondary">Project not found</p>
      </div>
    )
  }

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 pb-12">
        <div className="space-y-2">
        {/* Project Name */}
        <SettingsSection
          title="Project Name"
          description="The display name for this project in the sidebar and headers."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            placeholder="Enter project name"
            className="max-w-md"
          />
        </SettingsSection>

        {/* Branch Prefix — hidden when using Perforce */}
        {!p4Stream && (
        <SettingsSection
          title="Branch Prefix"
          description="Custom prefix for git branches created by tickets. The ticket ID will be appended after a slash."
        >
          <div className="space-y-2">
            <Input
              value={branchPrefix}
              onChange={(e) => handleBranchPrefixChange(e.target.value)}
              onBlur={handleBranchPrefixBlur}
              onKeyDown={handleBranchPrefixKeyDown}
              placeholder="potato"
              className="max-w-md"
            />
            {branchPrefixError ? (
              <p className="text-sm text-accent-red">{branchPrefixError}</p>
            ) : (
              <p className="text-sm text-text-secondary">
                Branches will be named: {branchPrefix || 'potato'}/POT-XX
              </p>
            )}
          </div>
        </SettingsSection>
        )}

        {/* Template */}
        <SettingsSection
          title="Template"
          description="The workflow template used for this project. Changing the template will reset the project phases."
        >
          <Select value={selectedTemplate || (p4Stream ? 'product-development-p4' : '')} onValueChange={handleTemplateChange}>
            <SelectTrigger className="max-w-md">
              <SelectValue placeholder="Select a template" />
            </SelectTrigger>
            <SelectContent>
              {templates?.map((template) => (
                <SelectItem key={template.name} value={template.name}>
                  {template.name}
                  {template.isDefault && ' (default)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Version display */}
          {templateStatus?.current ? (
            <p className="mt-2 text-sm text-text-secondary">
              v{templateStatus.current} ·{' '}
              <button
                onClick={() => setShowChangelog(true)}
                className="text-blue-400 hover:text-blue-300 hover:underline"
              >
                View Changelog
              </button>
            </p>
          ) : selectedTemplate ? null : (
            <p className="mt-2 text-sm text-text-secondary">
              No template selected
            </p>
          )}
        </SettingsSection>

        {/* Project Color */}
        <SettingsSection
          title="Project Color"
          description="Choose a color for the project icon and name in the sidebar."
        >
          <ProjectColorPicker
            value={color}
            onChange={handleColorChange}
            disabled={updateProject.isPending}
          />
        </SettingsSection>

        {/* Project Icon */}
        <SettingsSection
          title="Project Icon"
          description="Choose an icon to help identify this project."
        >
          <ProjectIconPicker
            value={icon}
            onChange={handleIconChange}
            disabled={updateProject.isPending}
            projectColor={color}
          />
        </SettingsSection>

        {/* Perforce */}
        <SettingsSection
          title="Perforce"
          description="Perforce (P4) VCS settings. Set the stream depot path to use Perforce-managed workspaces instead of Git branches."
        >
          <div className="space-y-4 max-w-md">
            {/* P4 Stream */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">P4 Stream</label>
              <Input
                value={p4Stream}
                onChange={(e) => handleP4StreamChange(e.target.value)}
                onBlur={handleP4StreamBlur}
                onKeyDown={handleP4StreamKeyDown}
                placeholder="//depot/main"
              />
              {p4StreamError ? (
                <p className="text-sm text-accent-red">{p4StreamError}</p>
              ) : (
                <p className="text-sm text-text-secondary">
                  Perforce stream depot path (must start with //)
                </p>
              )}
            </div>
            {/* Agent Workspace Root */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">
                Agent Workspace Root
                {p4Stream && <span className="ml-1 text-accent-red">*</span>}
              </label>
              <Input
                value={agentWorkspaceRoot}
                onChange={(e) => handleAgentWorkspaceRootChange(e.target.value)}
                onBlur={handleAgentWorkspaceRootBlur}
                onKeyDown={handleAgentWorkspaceRootKeyDown}
                placeholder="/home/agent/workspaces"
              />
              {agentWorkspaceRootError ? (
                <p className="text-sm text-accent-red">{agentWorkspaceRootError}</p>
              ) : (
                <p className="text-sm text-text-secondary">
                  Root directory for P4 agent workspaces{p4Stream ? ' (required)' : ' (required when P4 Stream is set)'}
                </p>
              )}
            </div>
            {/* Helix Swarm URL */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">Helix Swarm URL</label>
              <Input
                value={helixSwarmUrl}
                onChange={(e) => handleHelixSwarmUrlChange(e.target.value)}
                onBlur={handleHelixSwarmUrlBlur}
                onKeyDown={handleHelixSwarmUrlKeyDown}
                placeholder="https://swarm.example.com"
              />
              {helixSwarmUrlError ? (
                <p className="text-sm text-accent-red">{helixSwarmUrlError}</p>
              ) : (
                <p className="text-sm text-text-secondary">
                  Optional: Helix Swarm code review server URL
                </p>
              )}
            </div>
          </div>
        </SettingsSection>

        {/* Workflows */}
        <WorkflowsSection project={project} />

        {/* Danger Zone */}
        <SettingsSection
          title="Danger Zone"
          description="Permanently delete this project. This action cannot be undone."
          danger
        >
          <Button
            variant="destructive"
            onClick={() => setShowDeleteDialog(true)}
          >
            Delete Project
          </Button>
        </SettingsSection>
        </div>
      </div>

      {/* Template Change Confirmation Dialog */}
      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Template?</DialogTitle>
            <DialogDescription>
              Changing the template to "{pendingTemplate}" will reset the project phases.
              Existing tickets will remain but may need to be moved to new phases.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowTemplateDialog(false)}
              disabled={isChangingTemplate}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmTemplateChange}
              disabled={isChangingTemplate}
            >
              {isChangingTemplate ? 'Changing...' : 'Change Template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-accent-red" />
              Delete Project?
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{project.displayName || project.id}"?
              This will remove the project from Potato Cannon but will not delete
              any files from your filesystem. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Changelog Modal */}
      {showChangelog && (
        <ChangelogModal
          projectId={projectId}
          onClose={() => setShowChangelog(false)}
        />
      )}
    </div>
  )
}
