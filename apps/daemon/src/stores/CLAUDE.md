# Stores

Data persistence layer for Potato Cannon.

## Database

**Location:** `~/.potato-cannon/potato.db` (SQLite)

**Library:** `better-sqlite3` - synchronous API, fast, works with Electron.

### Initialization

```typescript
import { initDatabase, closeDatabase } from './db.js';

// At daemon startup
initDatabase();

// At daemon shutdown
closeDatabase();
```

### WAL Mode

The database uses WAL (Write-Ahead Logging) mode for better concurrency. Multiple readers can access data while a write is in progress.

## Schema Migrations

Migrations use SQLite's `user_version` pragma. Each migration checks the version and applies changes if needed.

**Current schema version:** 17

**Adding a new migration:**

1. Increment `CURRENT_SCHEMA_VERSION` in `migrations.ts`
2. Add a new `if (version < N)` block with your schema changes
3. Migrations run automatically at startup

```typescript
// Example: adding a new column
if (version < 6) {
  db.exec(`ALTER TABLE tickets ADD COLUMN new_field TEXT`);
}
```

### Migration History

| Version | Description |
|---------|-------------|
| V1 | Initial schema - `projects` table |
| V2 | Tickets, history, and sessions |
| V3 | Unified conversations, sessions, and brainstorms |
| V4 | Backfill conversation_id for existing tickets |
| V5 | Tasks, provider channels, ralph feedback, artifacts, templates, config |
| V6 | Add `branch_prefix` column to projects table (default: 'potato') |
| V7 | Add `folders` table and `folder_id` FK on projects |
| V8 | Add Perforce project configuration columns (`p4_stream`, `agent_workspace_root`, `helix_swarm_url`) to projects |
| V9 | Add `suggested_p4_stream` column to projects (AI-detected P4 stream on registration) |
| V10 | Add `vcs_type` column to projects (default 'git'); backfill 'perforce' for projects with `p4_stream` set |
| V11 | Add `p4_mcp_server_path` column to projects |
| V12 | Add `complexity` column to tickets and tasks (default 'standard'; CHECK constraint: simple/standard/complex) |
| V13 | Add `project_workflows` table + `workflow_id` FK on tickets; backfill default workflow per project |
| V14 | Add `ticket_dependencies` table and `workflow_id` FK on brainstorms |
| V15 | Add `metadata` field to `ticket_history` |
| V16 | Add `execution_generation` fields and active session uniqueness fencing |
| V17 | Add `chat_queue_items` and `chat_delivery_events`; add provider route metadata indexes |

## Tables

### Core Tables

| Table | Description |
|-------|-------------|
| `projects` | Registered projects with template info |
| `tickets` | Ticket metadata (title, description, phase, worker_state) |
| `ticket_counters` | Auto-increment counters for ticket IDs |
| `ticket_history` | Phase transition history |
| `brainstorms` | Brainstorm sessions |
| `conversations` | Chat containers for tickets/brainstorms |
| `conversation_messages` | Message history (questions, responses, notifications, artifacts) |
| `sessions` | Claude session tracking |

### V5 Tables (Phase 2 Migration)

| Table | Description |
|-------|-------------|
| `tasks` | Tasks within tickets (status, phase, attempt_count) |
| `task_comments` | Comments on tasks |
| `provider_channels` | Chat provider channel mappings (Telegram, etc.) |
| `ralph_feedback` | Ralph loop tracking per ticket/phase |
| `ralph_iterations` | Individual review iterations |
| `artifacts` | Artifact metadata (file content on disk) |
| `artifact_versions` | Version history for artifacts |
| `templates` | Template registry (workflow files on disk) |
| `config` | Key-value configuration store |

### V13 Tables

| Table | Description |
|-------|-------------|
| `project_workflows` | Named workflow boards per project, each referencing a template |

## Directory Structure

**Global directory:** `~/.potato-cannon/`

```
~/.potato-cannon/
├── potato.db                    # SQLite database
├── config.json                  # Legacy global config (file-based)
├── daemon.json                  # Running daemon info
├── daemon.pid                   # Daemon PID file
├── templates/                   # Workflow templates
│   └── {template-name}/
│       ├── workflow.json        # Phase definitions
│       ├── changelog.md         # Version history
│       └── agents/              # Agent prompts
│           ├── brainstorm.md
│           ├── refinement.md
│           └── ...
├── tasks/                       # Ticket file storage
│   └── {project-id}/
│       └── {ticket-id}/
│           ├── images/          # Uploaded images
│           └── artifacts/       # Generated artifacts
│               ├── manifest.json
│               ├── refinement.md
│               └── ...
├── sessions/                    # Claude session logs
└── brainstorms/                 # Brainstorm IPC files
    └── {project-id}/
        └── {brainstorm-id}/
            ├── pending-question.json
            └── pending-response.json
```

## Stores

### project.store.ts

Projects backed by SQLite `projects` table.

```typescript
getAllProjects(): Project[]
getProjectById(id: string): Project | null
getProjectBySlug(slug: string): Project | null
createProject(input: CreateProjectInput): Project
updateProject(id: string, updates: Partial<Project>): Project | null
deleteProject(id: string): boolean
```

**IDs:** Project IDs are auto-generated UUIDs. Do not pass an ID when creating a project.

**Slugs:** Projects have a URL-safe `slug` field auto-generated from the display name. Use `getProjectBySlug()` for URL routing.

### ticket.store.ts

Tickets and history entries backed by SQLite.

**Tables:**
- `tickets` - Main ticket records (includes `conversation_id`, `description`, `worker_state`)
- `ticket_history` - Phase transition history
- `ticket_counters` - Auto-increment counters for ticket IDs

```typescript
// Core CRUD
listTickets(projectId: string, options?: ListTicketsOptions): Ticket[]
getTicket(projectId: string, ticketId: string): Ticket | null
createTicket(projectId: string, input: CreateTicketInput): Ticket
updateTicket(projectId: string, ticketId: string, updates: UpdateTicketInput): Ticket | null
deleteTicket(projectId: string, ticketId: string): boolean
archiveTicket(projectId: string, ticketId: string): Ticket | null
restoreTicket(projectId: string, ticketId: string): Ticket | null

// History
getTicketHistory(ticketId: string): TicketHistoryEntry[]
getCurrentHistoryEntry(ticketId: string): { id: string; entry: TicketHistoryEntry } | null

// Worker State (JSON column)
getWorkerState(ticketId: string): OrchestrationState | null
setWorkerState(ticketId: string, state: OrchestrationState): void
clearWorkerState(ticketId: string): void

// DI for testing
createTicketStore(db: Database.Database): TicketStore
```

**IDs:** Ticket IDs are prefix-based (e.g., "POT-1") derived from the project's display name.

**Description:** Ticket descriptions are stored in the `description` TEXT column (V5 migration).

**Worker State:** JSON-serialized `OrchestrationState` stored in `worker_state` column for session recovery.

**File-based entities:** Images and artifacts remain file-based within each ticket's directory.

### task.store.ts

Tasks within tickets backed by SQLite.

**Tables:**
- `tasks` - Task metadata (description, body, status, phase, attempt_count)
- `task_comments` - Comments on tasks

```typescript
// Task CRUD
createTask(ticketId: string, phase: string, input: CreateTaskInput): Task
getTask(taskId: string): Task | null
getTaskByDisplayNumber(ticketId: string, displayNumber: number): Task | null
listTasks(ticketId: string, options?: { phase?: string }): Task[]
listTasksByStatus(ticketId: string, status: TaskStatus): Task[]
updateTask(taskId: string, updates: { description?: string; body?: string; phase?: string }): Task | null
updateTaskStatus(taskId: string, status: TaskStatus): Task | null
deleteTask(taskId: string): boolean

// Comments
addComment(taskId: string, text: string): TaskComment | null
getComment(commentId: string): TaskComment | null
getComments(taskId: string): TaskComment[]

// DI for testing
createTaskStore(db: Database.Database): TaskStore
```

**Task statuses:** `pending`, `in_progress`, `completed`, `failed`

**Attempt tracking:** `attempt_count` increments on failure, resets to 0 on completion.

**Display numbers:** Tasks have auto-incrementing `display_number` per ticket (1, 2, 3...).

### conversation.store.ts

Unified message storage for tickets and brainstorms.

**Tables:**
- `conversations` - Reusable chat container (linked via `conversation_id` on tickets/brainstorms)
- `conversation_messages` - Messages within a conversation

```typescript
// Conversation CRUD
createConversation(projectId: string): Conversation
getConversation(conversationId: string): Conversation | null
deleteConversation(conversationId: string): boolean

// Message CRUD
addMessage(conversationId: string, input: CreateMessageInput): ConversationMessage
getMessage(messageId: string): ConversationMessage | null
getMessages(conversationId: string): ConversationMessage[]
getPendingQuestion(conversationId: string): ConversationMessage | null
answerQuestion(messageId: string): boolean

// DI for testing
createConversationStore(db: Database.Database): ConversationStore
```

**Message types:**
- `question` - Question from Claude (with optional `options` array)
- `user` - User response
- `notification` - Status update (no response needed)
- `artifact` - Artifact attachment (filename/description in `metadata.artifact`)

**Pending questions:** Questions have `answered_at` set to null until answered. Use `getPendingQuestion()` to find unanswered questions.

### session.store.ts

Unified session tracking for tickets and brainstorms.

**Table:** `sessions`

```typescript
createSession(input: CreateSessionInput): Session
getSession(sessionId: string): Session | null
endSession(sessionId: string, exitCode?: number): boolean
updateClaudeSessionId(sessionId: string, claudeSessionId: string): boolean
getSessionsByTicket(ticketId: string): Session[]
getSessionsByBrainstorm(brainstormId: string): Session[]
getActiveSessionForTicket(ticketId: string): Session | null
getActiveSessionForBrainstorm(brainstormId: string): Session | null
hasActiveSession(ticketId?: string, brainstormId?: string): boolean
getLatestClaudeSessionId(brainstormId: string): string | null

// DI for testing
createSessionStore(db: Database.Database): SessionStore
```

**Session links:** Each session links to either a ticket OR a brainstorm (not both), plus optionally a conversation.

### brainstorm.store.ts

Brainstorm sessions backed by SQLite. Each brainstorm has an associated conversation.

**Table:** `brainstorms`

```typescript
createBrainstorm(projectId: string, name: string): Brainstorm
getBrainstorm(projectId: string, brainstormId: string): Promise<Brainstorm>
listBrainstorms(projectId: string): Brainstorm[]
updateBrainstorm(brainstormId: string, updates): Brainstorm
deleteBrainstorm(brainstormId: string): boolean

// DI for testing
createBrainstormStore(db: Database.Database): BrainstormStore
```

### provider-channel.store.ts

Chat provider channel mappings backed by SQLite. Maps tickets/brainstorms to external chat channels (Telegram forum topics, etc.).

**Table:** `provider_channels`

```typescript
// Channel CRUD
createChannel(input: CreateChannelInput): ProviderChannel
getChannel(id: string): ProviderChannel | null
getChannelForTicket(ticketId: string, providerId: string): ProviderChannel | null
getChannelForBrainstorm(brainstormId: string, providerId: string): ProviderChannel | null
findChannelByProviderChannel(providerId: string, channelId: string): ProviderChannel | null
listChannels(options?: ListChannelsOptions): ProviderChannel[]
deleteChannel(id: string): boolean

// DI for testing
createProviderChannelStore(db: Database.Database): ProviderChannelStore
```

**Uniqueness:** Each ticket/brainstorm can have only one channel per provider (enforced by UNIQUE constraint).

**Reverse lookup:** Use `findChannelByProviderChannel()` to route incoming messages from providers.

### ralph-feedback.store.ts

Ralph loop tracking backed by SQLite. Tracks review iterations for quality gates.

**Tables:**
- `ralph_feedback` - Loop instance (ticket, phase, loop ID, max attempts, status)
- `ralph_iterations` - Individual review iterations (approved/rejected, feedback, reviewer)

```typescript
// Feedback CRUD
createFeedback(input: CreateFeedbackInput): RalphFeedback
getFeedback(id: string): RalphFeedback | null
getFeedbackForLoop(ticketId: string, phaseId: string, ralphLoopId: string, taskId?: string): RalphFeedback | null
updateFeedbackStatus(id: string, status: RalphFeedbackStatus): RalphFeedback | null
deleteFeedback(id: string): boolean

// Iteration Operations
addIteration(feedbackId: string, input: CreateIterationInput): RalphIteration | null
getIteration(id: string): RalphIteration | null
getIterations(feedbackId: string): RalphIteration[]
getLatestIteration(feedbackId: string): RalphIteration | null

// DI for testing
createRalphFeedbackStore(db: Database.Database): RalphFeedbackStore
```

**Feedback statuses:** `running`, `approved`, `rejected`, `max_attempts`

**Uniqueness:** One feedback record per (ticket, phase, loop ID, task) combination.

### artifact.store.ts

Artifact metadata backed by SQLite. Actual file content is stored on disk.

**Tables:**
- `artifacts` - Artifact metadata (filename, type, description, phase, file_path)
- `artifact_versions` - Version history for artifacts

```typescript
// Artifact CRUD
createArtifact(input: CreateStoredArtifactInput): StoredArtifact
getArtifact(id: string): StoredArtifact | null
getArtifactByFilename(ticketId: string, filename: string): StoredArtifact | null
listArtifacts(ticketId: string): StoredArtifact[]
updateArtifact(id: string, updates: UpdateStoredArtifactInput): StoredArtifact | null
deleteArtifact(id: string): boolean

// Version Management
addVersion(artifactId: string, input: CreateStoredVersionInput): StoredArtifactVersion | null
getVersion(id: string): StoredArtifactVersion | null
getVersions(artifactId: string): StoredArtifactVersion[]
getLatestVersion(artifactId: string): StoredArtifactVersion | null

// DI for testing
createArtifactStore(db: Database.Database): ArtifactStore
```

**Hybrid storage:** SQLite stores metadata; actual files are in `~/.potato-cannon/tasks/{project}/{ticket}/artifacts/`.

**Uniqueness:** One artifact per filename per ticket.

### template.store.ts

Template registry backed by SQLite. Workflow files are stored on disk.

**Table:** `templates`

```typescript
// Registry (SQLite)
registerTemplate(input: RegisterTemplateInput): RegisteredTemplate
getTemplate(id: string): RegisteredTemplate | null
getTemplateByName(name: string): RegisteredTemplate | null
listTemplates(): RegisteredTemplate[]
updateTemplate(id: string, updates: UpdateTemplateInput): RegisteredTemplate | null
setDefaultTemplate(id: string): boolean
getDefaultTemplate(): RegisteredTemplate | null
deleteTemplate(id: string): boolean
upsertTemplate(input: RegisterTemplateInput): RegisteredTemplate

// File-based workflow access
getWorkflow(name: string): Promise<WorkflowTemplate | null>
getWorkflowWithFullPhases(name: string): Promise<WorkflowTemplate | null>
getAgentPrompt(templateName: string, agentPath: string): Promise<string>
createTemplate(name: string, description: string, phases: Phase[]): Promise<WorkflowTemplate>
updateTemplate(name: string, updates: { description?: string; phases?: Phase[] }): Promise<WorkflowTemplate>
deleteTemplate(name: string): Promise<void>
installDefaultTemplates(): Promise<void>

// Project-specific (prefers local copy over global)
getTemplateForProject(projectId: string): Promise<WorkflowTemplate | null>
getAgentPromptForProject(projectId: string, agentPath: string): Promise<string>

// DI for testing
createTemplateStore(db: Database.Database): TemplateStore
```

**Hybrid storage:** SQLite stores registry (name, version, isDefault); workflow files are in `~/.potato-cannon/templates/{name}/`.

**Full phases:** `getWorkflowWithFullPhases()` injects Ideas, Blocked, and Done phases around the workflow phases.

**Agent prompt overrides:** `getAgentPromptForProject()` supports per-project customization via `.override.md` files. Lookup order: project override > project standard > global catalog. See `templates/workflows/CLAUDE.md` for full documentation.

### project-template.store.ts

Per-project template storage and agent prompt overrides. Enables project-specific customizations that survive template updates.

**Directory:** `~/.potato-cannon/project-data/{projectId}/template/`

```typescript
// Template management
hasProjectTemplate(projectId: string): Promise<boolean>
getProjectTemplate(projectId: string): Promise<WorkflowTemplate | null>
copyTemplateToProject(projectId: string, templateName: string): Promise<WorkflowTemplate>
deleteProjectTemplate(projectId: string): Promise<void>

// Agent prompts
getProjectAgentPrompt(projectId: string, agentPath: string): Promise<string>

// Override support
hasProjectAgentOverride(projectId: string, agentPath: string): Promise<boolean>
getProjectAgentOverride(projectId: string, agentPath: string): Promise<string>

// Changelog
getProjectChangelog(projectId: string): Promise<string | null>
```

**Override convention:** Create `{agent}.override.md` alongside `{agent}.md` to customize an agent for a specific project. Override content completely replaces the standard prompt.

**Example:**
```
~/.potato-cannon/project-data/my-project/template/agents/
├── refinement.md           # Standard (from template)
└── refinement.override.md  # Custom override (takes priority)
```

See `templates/workflows/CLAUDE.md` for detailed override documentation.

### config.store.ts

Hybrid configuration storage: SQLite key-value store + file-based legacy config.

**Table:** `config`

```typescript
// SQLite key-value store
get<T>(key: string): T | null
set(key: string, value: unknown): void
delete(key: string): boolean
getAll(): Record<string, unknown>
getTelegramConfig(): TelegramConfig | null
setTelegramConfig(config: TelegramConfig): void
getDaemonConfig(): DaemonConfig | null
setDaemonConfig(config: DaemonConfig): void

// DI for testing
createConfigStore(db: Database.Database): ConfigStore
getConfigStore(): ConfigStore
```

**File-based (legacy):**
- `~/.potato-cannon/config.json` - Global settings (Telegram, daemon port)
- `~/.potato-cannon/daemon.json` - Running daemon info (port, pid, start time)
- `~/.potato-cannon/daemon.pid` - Daemon PID file

```typescript
// File-based functions
loadGlobalConfig(): Promise<GlobalConfig | null>
saveGlobalConfig(config: GlobalConfig): Promise<void>
readPid(): Promise<number | null>
writePid(pid: number): Promise<void>
readDaemonInfo(): Promise<DaemonInfo | null>
writeDaemonInfo(info: DaemonInfo): Promise<void>
```

### chat.store.ts

IPC for pending question/response files (used for Claude ↔ daemon communication).

```typescript
writePendingQuestion(projectId: string, ticketId: string, question: PendingQuestion): Promise<void>
readPendingQuestion(projectId: string, ticketId: string): Promise<PendingQuestion | null>
clearQuestion(projectId: string, ticketId: string): Promise<void>
writePendingResponse(projectId: string, ticketId: string, response: string): Promise<void>
readPendingResponse(projectId: string, ticketId: string): Promise<string | null>
clearResponse(projectId: string, ticketId: string): Promise<void>
```

**Note:** These files are transient IPC between daemon and Claude session. The actual message history is stored in SQLite via `conversation.store.ts`.

### artifact-chat.store.ts

In-memory session management for artifact chat contexts. Uses TTL-based cleanup.

```typescript
// ArtifactChatStore class (in-memory, not SQLite)
createSession(artifactId: string, ticketId: string): ArtifactChatSession
getSession(sessionId: string): ArtifactChatSession | null
updateActivity(sessionId: string): void
endSession(sessionId: string): void
deleteSession(sessionId: string): void
getActiveSessionForArtifact(artifactId: string): ArtifactChatSession | null
getAllSessions(): ArtifactChatSession[]
startCleanupTimer(): void
stopCleanupTimer(): void
clearAll(): void
```

**TTL:** Sessions expire after 30 minutes of inactivity. Cleanup runs every 5 minutes.

### chat-threads.store.ts

File-based provider thread mapping. Stores `chat-threads.json` in ticket/brainstorm directories.

```typescript
loadThreads(projectId: string, entityId: string, entityType: 'ticket' | 'brainstorm'): Promise<ChatThreads>
saveThreads(projectId: string, entityId: string, entityType: 'ticket' | 'brainstorm', threads: ChatThreads): Promise<void>
getProviderThread(projectId: string, entityId: string, entityType: 'ticket' | 'brainstorm', providerId: string): Promise<string | null>
setProviderThread(projectId: string, entityId: string, entityType: 'ticket' | 'brainstorm', providerId: string, threadId: string): Promise<void>
getAllThreads(): Promise<{ projectId: string; entityId: string; entityType: string; threads: ChatThreads }[]>
scanAllChatThreads(): Promise<ChatThreadMapping[]>
```

### ticket-log.store.ts

Ticket-specific daemon logging utility.

```typescript
appendTicketLog(projectId: string, ticketId: string, message: string): Promise<void>
readTicketLogs(projectId: string, ticketId: string): Promise<string>
```

**Location:** Logs stored at `~/.potato-cannon/projects/{projectId}/tickets/{ticketId}/logs/daemon.log`

### project-workflow.store.ts

Named workflow boards per project backed by SQLite. Enables multiple independent kanban boards per project, each referencing its own workflow template.

**Table:** `project_workflows`

**Schema:**
```sql
CREATE TABLE project_workflows (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  template_name TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(project_id, name)
);
```

**Indexes:**
- `idx_project_workflows_project` — on `project_id` for fast per-project listing
- `idx_project_workflows_default` — partial index on `(project_id, is_default) WHERE is_default = 1` for fast default lookup

**Relationship to `projects`:** Each `project_workflows` row belongs to one project via `project_id`. Deleting a project cascades to delete all its workflows.

**Relationship to `tickets`:** The `tickets` table has a nullable `workflow_id TEXT REFERENCES project_workflows(id) ON DELETE SET NULL` column added in V13. Deleting a workflow sets `workflow_id` to NULL on its tickets (rather than blocking deletion).

**Single-default enforcement:** Only one workflow per project may have `is_default = 1`. `createWorkflow` and `updateWorkflow` both clear the existing default for the project before setting a new one, using a SQLite transaction.

```typescript
// Class-based store (DI / testing)
new ProjectWorkflowStore(db: Database.Database)

// Factory functions
createProjectWorkflowStore(db: Database.Database): ProjectWorkflowStore
getProjectWorkflowStore(): ProjectWorkflowStore

// Instance methods
createWorkflow(input: CreateWorkflowInput): ProjectWorkflow
getWorkflow(id: string): ProjectWorkflow | null
getDefaultWorkflow(projectId: string): ProjectWorkflow | null
listWorkflows(projectId: string): ProjectWorkflow[]
updateWorkflow(id: string, updates: UpdateWorkflowInput): ProjectWorkflow | null
deleteWorkflow(id: string): boolean

// Singleton convenience functions
projectWorkflowCreate(input: CreateWorkflowInput): ProjectWorkflow
projectWorkflowGet(id: string): ProjectWorkflow | null
projectWorkflowList(projectId: string): ProjectWorkflow[]
projectWorkflowUpdate(id: string, updates: UpdateWorkflowInput): ProjectWorkflow | null
projectWorkflowDelete(id: string): boolean
projectWorkflowGetDefault(projectId: string): ProjectWorkflow | null
```

**Method details:**

- `createWorkflow(input)` — Inserts a new workflow. If `input.isDefault` is true, clears all existing `is_default = 1` rows for the project first (in a single transaction). `isDefault` defaults to `false`.
- `getWorkflow(id)` — Returns the workflow or `null` if not found.
- `getDefaultWorkflow(projectId)` — Returns the workflow with `is_default = 1` for the project, or `null` if none is set.
- `listWorkflows(projectId)` — Returns all workflows for the project ordered alphabetically by `name`.
- `updateWorkflow(id, updates)` — Partial update. If `updates.isDefault === true`, clears other defaults first (in a transaction). Returns `null` if the workflow does not exist. Returns existing record unchanged if `updates` is empty.
- `deleteWorkflow(id)` — Deletes the workflow row. Returns `true` if deleted, `false` if not found. Associated tickets have their `workflow_id` set to NULL by the FK cascade.

**Input types:**
```typescript
interface CreateWorkflowInput {
  projectId: string;
  name: string;
  templateName: string;
  isDefault?: boolean;   // defaults to false
}

interface UpdateWorkflowInput {
  name?: string;
  templateName?: string;
  isDefault?: boolean;
}
```

**V13 Migration and Backfill:**

V13 creates the `project_workflows` table and adds the `workflow_id` column to `tickets`. After schema changes, `runBackfillV13()` runs automatically (and is also exported for testing):

1. For each existing project that has no `is_default = 1` workflow, a new workflow named `"Default"` is created using the project's `template_name` (falling back to `'product-development'` if unset).
2. All tickets with `workflow_id IS NULL` for each project are updated to reference their project's default workflow.

The backfill is **idempotent**: it checks for an existing default with a SELECT before inserting (application-level idempotency check), and only updates tickets with `NULL workflow_id`. Re-running the migration on an already-migrated database is safe.

## Conventions

1. **Sync functions** - `better-sqlite3` is synchronous, so store functions are sync (except file I/O)
2. **ISO timestamps** - All dates stored as ISO 8601 strings
3. **JSON columns** - Arrays and objects stored as JSON strings in TEXT columns
4. **Prepared statements** - Use `db.prepare()` for queries with parameters to prevent SQL injection
5. **Factory functions** - Each store has a `createXxxStore(db)` factory for dependency injection in tests
6. **Singleton accessors** - Top-level convenience functions use `getDatabase()` for production use
7. **Hybrid storage** - Metadata in SQLite, large content (files, templates) on disk
8. **CASCADE deletes** - Child records deleted automatically when parent is deleted
