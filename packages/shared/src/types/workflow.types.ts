export interface ProjectWorkflow {
  id: string
  projectId: string
  name: string
  templateName: string
  templateVersion: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateWorkflowInput {
  projectId: string
  name: string
  templateName: string
  templateVersion?: string
  isDefault?: boolean
}

export interface UpdateWorkflowInput {
  name?: string
  templateName?: string
  templateVersion?: string
  isDefault?: boolean
}
