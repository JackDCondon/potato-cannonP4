// src/api/client.ts
import type {
  Project,
  Folder,
  Ticket,
  Session,
  SessionMeta,
  Brainstorm,
  BrainstormMessage,
  Template,
  Artifact,
  CreateBrainstormResponse,
  BrainstormPendingResponse,
  BrainstormMessagesResponse,
  TemplatePhase,
  SessionLogEntry,
  ConversationEntry,
  TicketPendingResponse,
  TicketMessagesResponse,
  TicketMessage,
  Task,
  ArtifactChatStartResponse,
  ArtifactChatPendingResponse,
  ArchiveResult,
  WorkerTreeResponse,
  LogEntry,
  Complexity,
  ProjectWorkflow,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  DependencyTier,
  TicketDependency,
  BlockedByEntry,
  TicketLifecycleConflictPayload,
  StaleTicketInputPayload,
  TicketLifecycleErrorPayload,
  ChatNotificationPolicy,
  PmConfig,
  BoardSettings,
} from '@potato-cannon/shared'

export type { SessionLogEntry } from '@potato-cannon/shared'
export type TicketSessionResponse = SessionMeta
export type ProjectResponse = Project & {
  p4UseEnvVars?: boolean
  p4Port?: string
  p4User?: string
}
export interface GlobalConfigResponse {
  perforce: {
    mcpServerPath: string
  }
  ai: {
    defaultProvider: string
    providers: Array<{
      id: string
      models: {
        low: string
        mid: string
        high: string
      }
    }>
  }
}

export interface WorkflowDeletePreviewResponse {
  workflowId: string
  ticketCount: number
  sampleTicketIds: string[]
  requiresForce: boolean
  expectedConfirmation: string
}

export interface WorkflowTemplateStatusResponse {
  current: string | null
  available: string | null
  upgradeType: 'major' | 'minor' | 'patch' | null
}

const BASE_URL = ''

type ApiErrorPayload = {
  message?: string
  error?: string
  code?: string
  [key: string]: unknown
}

export class ApiError extends Error {
  status: number
  code?: string
  payload: ApiErrorPayload | null

  constructor(status: number, message: string, code?: string, payload: ApiErrorPayload | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

export function isTicketLifecycleConflictPayload(
  payload: unknown
): payload is TicketLifecycleConflictPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { code?: string }).code === 'TICKET_LIFECYCLE_CONFLICT'
  )
}

export function isStaleTicketInputPayload(
  payload: unknown
): payload is StaleTicketInputPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { code?: string }).code === 'STALE_TICKET_INPUT'
  )
}

export function isTicketLifecycleErrorPayload(
  payload: unknown
): payload is TicketLifecycleErrorPayload {
  return (
    isTicketLifecycleConflictPayload(payload) ||
    isStaleTicketInputPayload(payload)
  )
}

/**
 * Filter out messages that have been soft-deleted via metadata.superseded.
 * PTY-captured messages that were later confirmed by an explicit chat_notify
 * call are marked superseded to avoid duplicates in the UI.
 */
function filterSupersededMessages<T extends { metadata?: Record<string, unknown> | null }>(
  messages: T[]
): T[] {
  return messages.filter((msg) => !msg.metadata?.superseded)
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  })

  if (!response.ok) {
    const bodyText = await response.text()
    let payload: ApiErrorPayload | null = null
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText) as ApiErrorPayload
      } catch {
        payload = { error: bodyText }
      }
    }
    const message = payload?.message || payload?.error || `Request failed (${response.status})`
    throw new ApiError(response.status, message, payload?.code, payload)
  }

  // Handle empty responses (e.g., DELETE returning void)
  const text = await response.text()
  return text ? JSON.parse(text) : (null as T)
}

export const api = {
  // ============ Global Config ============

  getGlobalConfig: () =>
    request<GlobalConfigResponse>('/api/config/global'),

  updatePerforceGlobalConfig: (mcpServerPath: string) =>
    request<{ ok: boolean; perforce: { mcpServerPath: string } }>('/api/config/global/perforce', {
      method: 'PUT',
      body: JSON.stringify({ mcpServerPath }),
    }),

  updateAiGlobalConfig: (ai: GlobalConfigResponse['ai']) =>
    request<{ ok: boolean; ai: GlobalConfigResponse['ai'] }>('/api/config/global/ai', {
      method: 'PUT',
      body: JSON.stringify(ai),
    }),

  // ============ Projects ============

  getProjects: () =>
    request<ProjectResponse[]>('/api/projects'),

  addProject: (path: string, displayName?: string | null, template?: string | null) =>
    request<ProjectResponse>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path, displayName, template })
    }),

  deleteProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),

  updateProject: (id: string, updates: { displayName?: string; icon?: string; color?: string; swimlaneColors?: Record<string, string>; branchPrefix?: string; folderId?: string | null; p4Stream?: string; agentWorkspaceRoot?: string; helixSwarmUrl?: string; p4UseEnvVars?: boolean; p4Port?: string; p4User?: string; vcsType?: 'git' | 'perforce'; p4McpServerPath?: string; providerOverride?: string | null }) =>
    request<ProjectResponse>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    }),

  toggleDisabledPhase: (projectId: string, phaseId: string, disabled: boolean) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/disabled-phases`, {
      method: 'PATCH',
      body: JSON.stringify({ phaseId, disabled })
    }),

  // ============ Folders ============

  getFolders: () =>
    request<Folder[]>('/api/folders'),

  createFolder: (name: string) =>
    request<Folder>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name })
    }),

  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name })
    }),

  deleteFolder: (id: string) =>
    request<void>(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),

  // ============ Tickets ============

  getTickets: (projectId: string, phase?: string) => {
    const url = phase
      ? `/api/tickets/${encodeURIComponent(projectId)}?phase=${encodeURIComponent(phase)}`
      : `/api/tickets/${encodeURIComponent(projectId)}`
    return request<Ticket[]>(url)
  },

  getTicket: (projectId: string, ticketId: string) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}`),

  createTicket: (projectId: string, title: string, description?: string, workflowId?: string) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ title, description, ...(workflowId ? { workflowId } : {}) })
    }),

  updateTicket: (
    projectId: string,
    ticketId: string,
    updates: Partial<Ticket> & { overrideDependencies?: boolean }
  ) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    }),

  deleteTicket: (projectId: string, ticketId: string) =>
    request<void>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}`, {
      method: 'DELETE'
    }),

  archiveTicket: (projectId: string, ticketId: string) =>
    request<ArchiveResult>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/archive`, {
      method: 'PATCH'
    }),

  setTicketComplexity: (projectId: string, ticketId: string, complexity: Complexity) =>
    request<Ticket>(`/api/projects/${encodeURIComponent(projectId)}/tickets/${encodeURIComponent(ticketId)}/complexity`, {
      method: 'PATCH',
      body: JSON.stringify({ complexity }),
    }),

  restoreTicket: (projectId: string, ticketId: string) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/restore`, {
      method: 'PATCH'
    }),

  restartTicketToPhase: (projectId: string, ticketId: string, targetPhase: string) =>
    request<{
      success: boolean;
      ticket: Ticket;
      sessionSpawned: boolean;
      cleanup: {
        sessionsDeleted: number;
        tasksDeleted: number;
        feedbackDeleted: number;
        historyEntriesDeleted: number;
        worktreeRemoved: boolean;
      };
    }>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/restart`, {
      method: 'POST',
      body: JSON.stringify({ targetPhase })
    }),

  resumeTicket: (projectId: string, ticketId: string) =>
    request<{ ticket: Ticket }>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/resume`, {
      method: 'POST'
    }),

  getArchivedTickets: (projectId: string) =>
    request<Ticket[]>(`/api/tickets/${encodeURIComponent(projectId)}?archived=true`),

  // ============ Ticket Images ============

  getTicketImages: (projectId: string, ticketId: string) =>
    request<string[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/images`),

  uploadImage: async (projectId: string, ticketId: string, file: File) => {
    const formData = new FormData()
    formData.append('image', file)
    const response = await fetch(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/images`,
      { method: 'POST', body: formData }
    )
    if (!response.ok) throw new Error('Upload failed')
    return response.json() as Promise<{ name: string }>
  },

  deleteImage: (projectId: string, ticketId: string, filename: string) =>
    request<void>(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/images/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    ),

  // ============ Ticket Artifacts ============

  getTicketArtifacts: (projectId: string, ticketId: string) =>
    request<Artifact[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/artifacts`),

  getTicketArtifact: async (projectId: string, ticketId: string, filename: string) => {
    const response = await fetch(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/artifacts/${encodeURIComponent(filename)}`
    )
    if (!response.ok) throw new Error('Artifact not found')
    return response.text()
  },

  updateTicketArtifact: (projectId: string, ticketId: string, filename: string, content: string) =>
    request<{ ok: true; filename: string; isNewVersion: boolean }>(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/artifacts/${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    ),

  // ============ Ticket Conversations ============

  getTicketConversations: (projectId: string, ticketId: string) =>
    request<ConversationEntry[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/conversations`),

  getTicketMessages: async (projectId: string, ticketId: string) => {
    const result = await request<TicketMessagesResponse>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/messages`)
    return {
      ...result,
      messages: filterSupersededMessages(result.messages as Array<TicketMessage & { metadata?: Record<string, unknown> | null }>)
    } as TicketMessagesResponse
  },

  getTicketPending: (projectId: string, ticketId: string) =>
    request<TicketPendingResponse>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/pending`),

  sendTicketInput: (
    projectId: string,
    ticketId: string,
    message: string,
    identity?: { questionId?: string; ticketGeneration?: number }
  ) =>
    request<void>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/input`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(identity?.questionId ? { questionId: identity.questionId } : {}),
        ...(typeof identity?.ticketGeneration === 'number'
          ? { ticketGeneration: identity.ticketGeneration }
          : {}),
      })
    }),

  getTicketTasks: (projectId: string, ticketId: string, phase?: string) =>
    request<Task[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/tasks${phase ? `?phase=${encodeURIComponent(phase)}` : ''}`),

  // ============ Sessions ============

  getTicketSessions: (projectId: string, ticketId: string) =>
    request<TicketSessionResponse[]>(`/api/projects/${encodeURIComponent(projectId)}/tickets/${encodeURIComponent(ticketId)}/sessions`),

  getSessions: () =>
    request<Session[]>('/api/sessions'),

  getSessionLog: (sessionId: string) =>
    request<SessionLogEntry[]>(`/api/sessions/${sessionId}`),

  stopSession: (sessionId: string) =>
    request<void>(`/api/sessions/${sessionId}/stop`, { method: 'POST' }),

  // ============ Remote Control ============

  getRemoteControl: (projectId: string, ticketId: string) =>
    request<{ sessionId?: string; pending: boolean; url: string | null }>(
      `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/remote-control`
    ),

  startRemoteControl: (projectId: string, ticketId: string, ticketTitle: string) =>
    request<{ ok: boolean; sessionId: string }>(
      `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/remote-control/start`,
      {
        method: 'POST',
        body: JSON.stringify({ ticketTitle }),
      }
    ),

  // ============ System Logs ============

  getSystemLogs: (lines = 500) =>
    request<{ entries: LogEntry[] }>(`/api/system/logs?lines=${lines}`).then((d) => d.entries),

  // ============ Phases ============

  getPhases: () =>
    request<string[]>('/api/phases'),

  getProjectPhases: (projectId: string) =>
    request<string[]>(`/api/projects/${encodeURIComponent(projectId)}/phases`),

  // ============ Brainstorms ============

  getBrainstorms: (projectId: string) =>
    request<Brainstorm[]>(`/api/brainstorms/${encodeURIComponent(projectId)}`),

  getBrainstorm: (projectId: string, brainstormId: string) =>
    request<Brainstorm>(`/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}`),

  createBrainstorm: (projectId: string, options?: { name?: string | null; initialMessage?: string; workflowId?: string }) =>
    request<CreateBrainstormResponse>(`/api/brainstorms/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify(options ?? {})
    }),

  resumeBrainstorm: (projectId: string, brainstormId: string) =>
    request<CreateBrainstormResponse>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/resume`,
      { method: 'POST' }
    ),

  sendBrainstormInput: (projectId: string, brainstormId: string, message: string) =>
    request<void>(`/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/input`, {
      method: 'POST',
      body: JSON.stringify({ message })
    }),

  getBrainstormPending: (projectId: string, brainstormId: string) =>
    request<BrainstormPendingResponse>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/pending`
    ),

  getBrainstormMessages: async (projectId: string, brainstormId: string) => {
    const result = await request<BrainstormMessagesResponse>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/messages`
    )
    return {
      ...result,
      messages: filterSupersededMessages(result.messages as Array<BrainstormMessage & { metadata?: Record<string, unknown> | null }>)
    } as BrainstormMessagesResponse
  },

  deleteBrainstorm: (projectId: string, brainstormId: string) =>
    request<void>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}`,
      { method: 'DELETE' }
    ),

  getBrainstormArtifacts: (projectId: string, brainstormId: string) =>
    request<{ artifacts: Array<{ filename: string; content: string; updatedAt: string }> }>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/artifacts`
    ),

  updateBrainstorm: (projectId: string, brainstormId: string, updates: { name?: string; color?: string | null; icon?: string | null }) =>
    request<Brainstorm>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}`,
      { method: 'PUT', body: JSON.stringify(updates) }
    ),

  // ============ Templates ============

  getTemplates: () =>
    request<Template[]>('/api/templates'),

  getTemplate: (name: string) =>
    request<Template>(`/api/templates/${encodeURIComponent(name)}`),

  getTemplateFull: (name: string) =>
    request<Template>(`/api/templates/${encodeURIComponent(name)}?full=true`),

  createTemplate: (name: string, description: string, phases: TemplatePhase[] = []) =>
    request<Template>('/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name, description, phases })
    }),

  updateTemplate: (name: string, updates: Partial<Template>) =>
    request<Template>(`/api/templates/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    }),

  deleteTemplate: (name: string) =>
    request<void>(`/api/templates/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    }),

  setDefaultTemplate: (name: string) =>
    request<void>(`/api/templates/${encodeURIComponent(name)}/default`, {
      method: 'POST'
    }),

  // ============ Project Template ============

  setProjectTemplate: (projectId: string, templateName: string) =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}/template`, {
      method: 'PUT',
      body: JSON.stringify({ name: templateName })
    }),

  getProjectTemplateStatus: (projectId: string) =>
    request<{
      current: string | null;
      available: string | null;
      upgradeType: 'major' | 'minor' | 'patch' | null;
    }>(`/api/projects/${encodeURIComponent(projectId)}/template-status`),

  // ============ Agent Prompts ============

  getAgentPrompt: async (templateName: string, agentPath: string) => {
    const response = await fetch(
      `/api/templates/${encodeURIComponent(templateName)}/${agentPath}`
    )
    if (!response.ok) throw new Error('Agent not found')
    return response.text()
  },

  saveAgentPrompt: (templateName: string, agentPath: string, content: string) =>
    fetch(`/api/templates/${encodeURIComponent(templateName)}/${agentPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content
    }).then(r => {
      if (!r.ok) throw new Error('Failed to save agent prompt')
      return r.json()
    }),

  // ============ Artifact Chat ============

  startArtifactChat: (projectId: string, ticketId: string, artifact: string, message: string) =>
    request<ArtifactChatStartResponse>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/start`,
      {
        method: 'POST',
        body: JSON.stringify({ message })
      }
    ),

  getArtifactChatPending: (projectId: string, ticketId: string, artifact: string, contextId: string) =>
    request<ArtifactChatPendingResponse>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/pending?contextId=${encodeURIComponent(contextId)}`
    ),

  sendArtifactChatInput: (projectId: string, ticketId: string, artifact: string, contextId: string, message: string) =>
    request<{ ok: true }>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/input`,
      {
        method: 'POST',
        body: JSON.stringify({ contextId, message })
      }
    ),

  endArtifactChat: (projectId: string, ticketId: string, artifact: string, contextId: string) =>
    request<{ ok: true }>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/end`,
      {
        method: 'POST',
        body: JSON.stringify({ contextId })
      }
    ),

  // ============ Template Versioning ============

  getTemplateStatus: (projectId: string) =>
    request<{
      current: string | null;
      available: string | null;
      upgradeType: 'major' | 'minor' | 'patch' | null;
    }>(`/api/projects/${encodeURIComponent(projectId)}/template-status`),

  upgradeTemplate: (projectId: string, force?: boolean) =>
    request<{
      upgraded: boolean;
      previousVersion?: string;
      newVersion?: string;
      upgradeType?: 'major' | 'minor' | 'patch';
      message?: string;
      error?: string;
      ticketsToReset?: Array<{ id: string; title: string; phase: string }>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/upgrade-template`, {
      method: 'POST',
      body: JSON.stringify({ force })
    }),

  getTemplateChangelog: (projectId: string) =>
    request<{ changelog: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/template-changelog`),

  // ============ Phase Workers ============

  getPhaseWorkers: (projectId: string, phase: string, workflowId?: string | null) => {
    const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
    return request<WorkerTreeResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phase)}/workers${query}`
    )
  },

  // ============ Agent Overrides ============

  getAgentDefault: (projectId: string, agentType: string, workflowId?: string | null) => {
    const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
    return request<{ content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/default${query}`
    )
  },

  getAgentOverride: (projectId: string, agentType: string, workflowId?: string | null) => {
    const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
    return request<{ content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/override${query}`
    )
  },

  saveAgentOverride: (projectId: string, agentType: string, content: string, workflowId?: string | null) => {
    const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
    return request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/override${query}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content })
      }
    )
  },

  deleteAgentOverride: (projectId: string, agentType: string, workflowId?: string | null) => {
    const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
    return request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/override${query}`,
      { method: 'DELETE' }
    )
  },

  // ============ Workflows ============

  getWorkflows: (projectId: string) =>
    request<ProjectWorkflow[]>(`/api/projects/${encodeURIComponent(projectId)}/workflows`),

  createWorkflow: (input: CreateWorkflowInput) =>
    request<ProjectWorkflow>(`/api/projects/${encodeURIComponent(input.projectId)}/workflows`, {
      method: 'POST',
      body: JSON.stringify(input)
    }),

  updateWorkflow: (projectId: string, workflowId: string, updates: UpdateWorkflowInput) =>
    request<ProjectWorkflow>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates)
      }
    ),

  getWorkflowDeletePreview: (projectId: string, workflowId: string) =>
    request<WorkflowDeletePreviewResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/delete-preview`
    ),

  deleteWorkflow: (
    projectId: string,
    workflowId: string,
    options?: { force?: boolean; confirmation?: string }
  ) =>
    request<{ ok: boolean; deletedTickets?: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
      {
        method: 'DELETE',
        body: JSON.stringify(options ?? {}),
      }
    ),

  getWorkflowTemplateStatus: (projectId: string, workflowId: string) =>
    request<WorkflowTemplateStatusResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/template-status`
    ),

  getWorkflowTemplateChangelog: (projectId: string, workflowId: string) =>
    request<{ changelog: string | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/template-changelog`
    ),

  upgradeWorkflowTemplate: (projectId: string, workflowId: string, force?: boolean) =>
    request<{
      upgraded: boolean;
      previousVersion?: string;
      newVersion?: string;
      upgradeType?: 'major' | 'minor' | 'patch';
      message?: string;
      error?: string;
      ticketsToReset?: Array<{ id: string; title: string; phase: string }>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/upgrade-template`, {
      method: 'POST',
      body: JSON.stringify({ force })
    }),

  // ============ Ticket Dependencies ============

  getTicketDependencies: (projectId: string, ticketId: string) =>
    request<BlockedByEntry[]>(
      `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/dependencies`
    ),

  addTicketDependency: (projectId: string, ticketId: string, dependsOn: string, tier: DependencyTier) =>
    request<TicketDependency>(`/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({ dependsOn, tier })
    }),

  removeTicketDependency: (projectId: string, ticketId: string, dependsOn: string) =>
    request<void>(
      `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/dependencies?dependsOn=${encodeURIComponent(dependsOn)}`,
      { method: 'DELETE' }
    ),

  // ============ Board Settings ============

  getBoardSettings: (projectId: string, workflowId: string) =>
    request<{ pmConfig: PmConfig; chatNotificationPolicy: ChatNotificationPolicy }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/settings`
    ),

  updateBoardPmSettings: (projectId: string, workflowId: string, config: Partial<PmConfig>) =>
    request<{ pmConfig: PmConfig; settings: BoardSettings }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/settings/pm`,
      {
        method: 'PUT',
        body: JSON.stringify(config),
      }
    ),

  updateBoardNotificationSettings: (
    projectId: string,
    workflowId: string,
    policy: Partial<ChatNotificationPolicy>
  ) =>
    request<{ chatNotificationPolicy: ChatNotificationPolicy; settings: BoardSettings }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/settings/notifications`,
      {
        method: 'PUT',
        body: JSON.stringify(policy),
      }
    ),

  resetBoardPmSettings: (projectId: string, workflowId: string) =>
    request<{ ok: boolean; deleted: boolean; pmConfig: PmConfig }>(
      `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/settings/pm`,
      { method: 'DELETE' }
    ),
}
