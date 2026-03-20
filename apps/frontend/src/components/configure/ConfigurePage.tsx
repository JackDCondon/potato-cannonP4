import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
import { useProjects, useUpdateProject, useDeleteProject } from '@/hooks/queries'
import { api, type GlobalConfigResponse } from '@/api/client'

function isValidBranchPrefix(prefix: string): boolean {
  if (!prefix) return true
  return /^[a-zA-Z0-9/_-]+$/.test(prefix)
}

function isValidP4Stream(stream: string): boolean {
  if (!stream) return true
  return stream.startsWith('//')
}

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
  const { data: projects } = useProjects()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()

  const project = projects?.find((p) => p.id === projectId)

  const [name, setName] = useState('')
  const [icon, setIcon] = useState('package')
  const [color, setColor] = useState<string | undefined>(undefined)
  const [branchPrefix, setBranchPrefix] = useState('potato')
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(null)

  const [vcsType, setVcsType] = useState<'git' | 'perforce'>('git')
  const [p4Stream, setP4Stream] = useState('')
  const [p4StreamError, setP4StreamError] = useState<string | null>(null)
  const [agentWorkspaceRoot, setAgentWorkspaceRoot] = useState('')
  const [agentWorkspaceRootError, setAgentWorkspaceRootError] = useState<string | null>(null)
  const [helixSwarmUrl, setHelixSwarmUrl] = useState('')
  const [helixSwarmUrlError, setHelixSwarmUrlError] = useState<string | null>(null)
  const [p4UseEnvVars, setP4UseEnvVars] = useState(true)
  const [p4Port, setP4Port] = useState('')
  const [p4User, setP4User] = useState('')
  const [providerOverride, setProviderOverride] = useState('')
  const [globalAiConfig, setGlobalAiConfig] = useState<GlobalConfigResponse['ai'] | null>(null)

  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    if (project) {
      setName(project.displayName || project.id)
      setIcon(project.icon || 'package')
      setColor(project.color)
      setBranchPrefix(project.branchPrefix || 'potato')
      setBranchPrefixError(null)
      setVcsType(project.vcsType ?? 'git')
      const streamValue = project.p4Stream || project.suggestedP4Stream || ''
      setP4Stream(streamValue)
      setP4StreamError(null)
      setAgentWorkspaceRoot(project.agentWorkspaceRoot || '')
      setAgentWorkspaceRootError(null)
      setHelixSwarmUrl(project.helixSwarmUrl || '')
      setHelixSwarmUrlError(null)
      setP4UseEnvVars(project.p4UseEnvVars ?? true)
      setP4Port(project.p4Port || '')
      setP4User(project.p4User || '')
      setProviderOverride(project.providerOverride || '__inherit__')
    }
  }, [project])

  useEffect(() => {
    let cancelled = false
    api.getGlobalConfig()
      .then((config) => {
        if (!cancelled) setGlobalAiConfig(config.ai)
      })
      .catch(() => {
        if (!cancelled) setGlobalAiConfig(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleNameBlur = useCallback(() => {
    if (!project) return
    const newName = name.trim()
    if (newName && newName !== (project.displayName || project.id)) {
      updateProject.mutate({ id: projectId, updates: { displayName: newName } })
    }
  }, [name, project, projectId, updateProject])

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  const handleBranchPrefixChange = useCallback((value: string) => {
    setBranchPrefix(value)
    if (!isValidBranchPrefix(value)) {
      setBranchPrefixError(
        'Branch prefix can only contain letters, numbers, hyphens, underscores, and forward slashes',
      )
    } else {
      setBranchPrefixError(null)
    }
  }, [])

  const handleBranchPrefixBlur = useCallback(() => {
    if (!project) return
    if (branchPrefixError) return
    const newPrefix = branchPrefix.trim() || 'potato'
    if (newPrefix !== (project.branchPrefix || 'potato')) {
      updateProject.mutate({ id: projectId, updates: { branchPrefix: newPrefix } })
    }
  }, [branchPrefix, branchPrefixError, project, projectId, updateProject])

  const handleBranchPrefixKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  const handleVcsTypeChange = useCallback(
    (newType: 'git' | 'perforce') => {
      setVcsType(newType)
      updateProject.mutate({ id: projectId, updates: { vcsType: newType } })
    },
    [projectId, updateProject],
  )

  const handleP4StreamChange = useCallback(
    (value: string) => {
      setP4Stream(value)
      if (!isValidP4Stream(value)) {
        setP4StreamError('P4 Stream must start with //')
      } else {
        setP4StreamError(null)
      }
      if (value && !agentWorkspaceRoot) {
        setAgentWorkspaceRootError('Agent Workspace Root is required when P4 Stream is set')
      } else {
        setAgentWorkspaceRootError(null)
      }
    },
    [agentWorkspaceRoot],
  )

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

  const handleAgentWorkspaceRootChange = useCallback(
    (value: string) => {
      setAgentWorkspaceRoot(value)
      if (p4Stream && !value) {
        setAgentWorkspaceRootError('Agent Workspace Root is required when P4 Stream is set')
      } else {
        setAgentWorkspaceRootError(null)
      }
    },
    [p4Stream],
  )

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

  const handleHelixSwarmUrlChange = useCallback((value: string) => {
    setHelixSwarmUrl(value)
    if (!isValidUrl(value)) {
      setHelixSwarmUrlError('Helix Swarm URL must be a valid http or https URL')
    } else {
      setHelixSwarmUrlError(null)
    }
  }, [])

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

  const handleP4UseEnvVarsChange = useCallback(
    (checked: boolean) => {
      setP4UseEnvVars(checked)
      updateProject.mutate({ id: projectId, updates: { p4UseEnvVars: checked } })
    },
    [projectId, updateProject],
  )

  const handleP4PortBlur = useCallback(() => {
    if (!project) return
    const newPort = p4Port.trim()
    if (newPort !== (project.p4Port || '')) {
      updateProject.mutate({ id: projectId, updates: { p4Port: newPort || undefined } })
    }
  }, [p4Port, project, projectId, updateProject])

  const handleP4UserBlur = useCallback(() => {
    if (!project) return
    const newUser = p4User.trim()
    if (newUser !== (project.p4User || '')) {
      updateProject.mutate({ id: projectId, updates: { p4User: newUser || undefined } })
    }
  }, [p4User, project, projectId, updateProject])

  const handleP4FieldKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }, [])

  const handleProviderOverrideBlur = useCallback(() => {
    if (!project) return
    const selected = providerOverride === '__inherit__' ? null : providerOverride
    if ((project.providerOverride || null) !== selected) {
      updateProject.mutate({ id: projectId, updates: { providerOverride: selected } })
    }
  }, [project, projectId, providerOverride, updateProject])

  const handleIconChange = useCallback(
    (newIcon: string) => {
      setIcon(newIcon)
      updateProject.mutate({ id: projectId, updates: { icon: newIcon } })
    },
    [projectId, updateProject],
  )

  const handleColorChange = useCallback(
    (newColor: string) => {
      setColor(newColor)
      updateProject.mutate({ id: projectId, updates: { color: newColor } })
    },
    [projectId, updateProject],
  )

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

          <SettingsSection
            title="Version Control"
            description="Choose the version control system used by this project."
          >
            <div className="space-y-2 max-w-md">
              <label className="text-sm font-medium text-text-primary" htmlFor="vcs-type">
                VCS Type
              </label>
              <select
                id="vcs-type"
                value={vcsType}
                onChange={(e) => handleVcsTypeChange(e.target.value as 'git' | 'perforce')}
                className="border-border/50 bg-bg-tertiary/50 h-9 w-full rounded-md border px-3 text-sm"
              >
                <option value="git">Git</option>
                <option value="perforce">Perforce</option>
              </select>
            </div>
          </SettingsSection>

          {vcsType === 'git' && (
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

          {vcsType === 'perforce' && (
            <SettingsSection
              title="Perforce"
              description="Perforce (P4) VCS settings. Set the stream depot path to use Perforce-managed workspaces instead of Git branches."
            >
              <div className="space-y-4 max-w-md">
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
                      Root directory for P4 agent workspaces
                      {p4Stream ? ' (required)' : ' (required when P4 Stream is set)'}
                    </p>
                  )}
                </div>
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
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={p4UseEnvVars}
                      onChange={(e) => handleP4UseEnvVarsChange(e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm font-medium text-text-primary">
                      Use environment variables for P4PORT and P4USER
                    </span>
                  </label>
                  <p className="pl-6 text-sm text-text-secondary">
                    When enabled, P4PORT and P4USER are inherited from the daemon process
                    environment.
                  </p>
                </div>
                {!p4UseEnvVars && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-text-primary">P4 Port</label>
                      <Input
                        value={p4Port}
                        onChange={(e) => setP4Port(e.target.value)}
                        onBlur={handleP4PortBlur}
                        onKeyDown={handleP4FieldKeyDown}
                        placeholder="ssl:perforce.company.com:1666"
                      />
                      <p className="text-sm text-text-secondary">
                        Passed as <code>-p</code> to all p4 commands for this project.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-text-primary">P4 User</label>
                      <Input
                        value={p4User}
                        onChange={(e) => setP4User(e.target.value)}
                        onBlur={handleP4UserBlur}
                        onKeyDown={handleP4FieldKeyDown}
                        placeholder="username"
                      />
                      <p className="text-sm text-text-secondary">
                        Passed as <code>-u</code> to all p4 commands for this project.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </SettingsSection>
          )}

          <SettingsSection
            title="AI Provider Override"
            description="Choose a project-specific provider or inherit the global default."
          >
            <div className="space-y-2 max-w-md">
              <label className="text-sm font-medium text-text-primary" htmlFor="provider-override">
                Provider
              </label>
              <select
                id="provider-override"
                value={providerOverride}
                onChange={(e) => setProviderOverride(e.target.value)}
                onBlur={handleProviderOverrideBlur}
                className="border-border/50 bg-bg-tertiary/50 h-9 w-full rounded-md border px-3 text-sm"
              >
                <option value="__inherit__">
                  Inherited ({globalAiConfig?.defaultProvider || 'default'})
                </option>
                {(globalAiConfig?.providers || []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.id}
                  </option>
                ))}
              </select>
            </div>
          </SettingsSection>

          <WorkflowsSection project={project} />

          <SettingsSection
            title="Danger Zone"
            description="Permanently delete this project. This action cannot be undone."
            danger
          >
            <Button variant="destructive" onClick={() => setShowDeleteDialog(true)}>
              Delete Project
            </Button>
          </SettingsSection>
        </div>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-accent-red" />
              Delete Project?
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{project.displayName || project.id}"? This will
              remove the project from Potato Cannon but will not delete any files from your
              filesystem. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
