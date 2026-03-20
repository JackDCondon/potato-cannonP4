import type { Project } from './project.types.js'

const projectWithPerforceOverrides: Project = {
  id: 'project-1',
  slug: 'project-1',
  path: '/workspace/project-1',
  displayName: 'Project 1',
  p4UseEnvVars: false,
  p4Port: 'ssl:p4.example.com:1666',
  p4User: 'alice',
}

void projectWithPerforceOverrides
