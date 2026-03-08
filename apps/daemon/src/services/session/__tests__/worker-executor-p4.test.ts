import { describe, it, mock, before } from "node:test";
import assert from "node:assert";

/**
 * Tests for validateP4Prerequisites
 *
 * All module mocks are registered once before importing the SUT, using a shared
 * mutable "config" object to control per-test behavior.
 *
 * Mocked modules:
 *   - ../../../stores/project.store.js   (getProjectById + stub for other exports)
 *   - ../../../stores/phase-config.js    — not needed; we test validateP4Prerequisites directly
 *   - fs                                 (accessSync, mkdirSync, constants)
 *   - child_process                      (spawnSync)
 *
 * Because worker-executor.js also imports many other store/service modules that
 * require a live SQLite database, we mock them all with no-op stubs here.
 */

// ── Shared mutable state that each test configures before calling the SUT ──

interface FsConfig {
  accessSyncThrows: boolean;
  mkdirSyncThrows: boolean;
  mkdirSyncError: string;
}

interface SpawnConfig {
  status: number | null;
  stderr: string;
  errorMessage: string | null;
}

const projectState = {
  p4Stream: "//depot/stream" as string | null,
  agentWorkspaceRoot: "/tmp/workspace" as string | null,
};

const fsState: FsConfig = {
  accessSyncThrows: false,
  mkdirSyncThrows: false,
  mkdirSyncError: "Permission denied",
};

const spawnState: SpawnConfig = {
  status: 0,
  stderr: "",
  errorMessage: null,
};

// Track side effects
const sideEffects = {
  mkdirCalled: false,
};

// ── Register all mocks before importing the SUT ──

// 1. project.store mock — must include every named export imported across the
//    entire transitive closure (worker-executor.js, phase-config.js, etc.)
await mock.module("../../../stores/project.store.js", {
  namedExports: {
    getProjectById: (id: string) => {
      if (projectState.p4Stream === null && projectState.agentWorkspaceRoot === null) {
        return null;
      }
      return {
        id,
        name: "Test Project",
        path: "/test/path",
        p4Stream: projectState.p4Stream,
        agentWorkspaceRoot: projectState.agentWorkspaceRoot,
        templateName: "product-development",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    updateProjectTemplate: () => {},
    updateProject: () => {},
    getProjects: () => [],
    createProject: () => ({}),
    deleteProject: () => {},
  },
});

// 2. fs mock
await mock.module("fs", {
  namedExports: {
    accessSync: (_path: string, _mode: number) => {
      if (fsState.accessSyncThrows) {
        throw new Error("ENOENT: no such file or directory");
      }
    },
    mkdirSync: (_path: string, _opts: unknown) => {
      sideEffects.mkdirCalled = true;
      if (fsState.mkdirSyncThrows) {
        throw new Error(fsState.mkdirSyncError);
      }
    },
    constants: { F_OK: 0 },
  },
});

// 3. child_process mock
await mock.module("child_process", {
  namedExports: {
    spawnSync: (_cmd: string, _args: string[], _opts: unknown) => {
      const error = spawnState.errorMessage
        ? Object.assign(new Error(spawnState.errorMessage), { code: "ENOENT" })
        : undefined;
      return {
        status: spawnState.status,
        stderr: spawnState.stderr,
        stdout: "",
        error,
      };
    },
  },
});

// 4. Stub every other store / service the module graph pulls in
//    (prevents "Cannot find module" or SQLite initialization errors)
await mock.module("../../../stores/ticket.store.js", {
  namedExports: {
    updateTicket: async () => {},
    getTicket: () => null,
    getWorkerState: async () => null,
    saveWorkerState: async () => {},
    initWorkerState: async () => ({}),
    clearWorkerState: async () => {},
  },
});

await mock.module("../../../stores/chat.store.js", {
  namedExports: {
    readQuestion: async () => null,
    clearQuestion: async () => {},
  },
});

await mock.module("../../../stores/task.store.js", {
  namedExports: {
    updateTaskStatus: () => {},
  },
});

await mock.module("../ticket-logger.js", {
  namedExports: {
    logToDaemon: async () => {},
  },
});

await mock.module("../../../stores/ralph-feedback.store.js", {
  namedExports: {
    createRalphFeedback: () => {},
    addRalphIteration: () => {},
    updateRalphFeedbackStatus: () => {},
    getRalphFeedbackForLoop: () => null,
  },
});

await mock.module("../phase-config.js", {
  namedExports: {
    getPhaseConfig: async () => null,
    getNextEnabledPhase: async () => null,
    phaseRequiresIsolation: async () => false,
  },
});

await mock.module("../worker-state.js", {
  namedExports: {
    getWorkerState: async () => null,
    saveWorkerState: async () => {},
    initWorkerState: async () => ({
      phaseId: "Build",
      workerIndex: 0,
      activeWorker: null,
      updatedAt: new Date().toISOString(),
    }),
    clearWorkerState: async () => {},
    createAgentState: () => ({ id: "agent", type: "agent" }),
    prepareForRecovery: (s: unknown) => s,
  },
});

await mock.module("../loops/ralph-loop.js", {
  namedExports: {
    initRalphLoop: () => ({}),
    handleAgentCompletion: () => ({ nextState: null, result: { status: "approved" } }),
  },
});

await mock.module("../loops/task-loop.js", {
  namedExports: {
    initTaskLoop: () => ({}),
    getNextTask: () => null,
    startTask: () => ({}),
    advanceWorkerIndex: () => ({}),
    handleTaskWorkersComplete: () => ({ nextState: null, result: { status: "completed" } }),
    buildTaskContext: () => ({}),
  },
});

// ── Now import the SUT (after all mocks are registered) ──
const { validateP4Prerequisites } = await import("../worker-executor.js");

// ── Helper to reset state before each scenario ──
function resetState() {
  projectState.p4Stream = "//depot/stream";
  projectState.agentWorkspaceRoot = "/tmp/workspace";
  fsState.accessSyncThrows = false;
  fsState.mkdirSyncThrows = false;
  fsState.mkdirSyncError = "Permission denied";
  spawnState.status = 0;
  spawnState.stderr = "";
  spawnState.errorMessage = null;
  sideEffects.mkdirCalled = false;
}

// ── Tests ──

describe("validateP4Prerequisites", () => {
  // Scenario 1: Git project (no p4Stream) — skip validation, return null
  it("returns null for a Git project (no p4Stream)", () => {
    resetState();
    projectState.p4Stream = null;
    const result = validateP4Prerequisites("proj-git");
    assert.strictEqual(result, null);
  });

  // Scenario 2: p4Stream is whitespace-only — return error string
  it("returns error for whitespace-only p4Stream", () => {
    resetState();
    projectState.p4Stream = "   ";
    const result = validateP4Prerequisites("proj-1");
    assert.ok(result, "expected a non-null error string");
    assert.ok(
      result!.includes("p4Stream is empty"),
      `expected message about empty p4Stream, got: ${result}`
    );
  });

  // Scenario 3: missing agentWorkspaceRoot — return error string
  it("returns error when agentWorkspaceRoot is missing", () => {
    resetState();
    projectState.agentWorkspaceRoot = null;
    const result = validateP4Prerequisites("proj-1");
    assert.ok(result, "expected a non-null error string");
    assert.ok(
      result!.includes("agentWorkspaceRoot is not set"),
      `expected message about missing agentWorkspaceRoot, got: ${result}`
    );
  });

  // Scenario 4: directory exists (accessSync succeeds) — proceeds to p4 info, returns null
  it("proceeds to p4 info check when directory exists", () => {
    resetState();
    fsState.accessSyncThrows = false; // directory exists
    spawnState.status = 0;
    const result = validateP4Prerequisites("proj-1");
    assert.strictEqual(result, null, "expected null when directory exists and p4 info succeeds");
  });

  // Scenario 5: directory does not exist but mkdirSync succeeds — proceeds to p4 info
  it("proceeds to p4 info check when directory is created successfully", () => {
    resetState();
    fsState.accessSyncThrows = true;  // directory does not exist
    fsState.mkdirSyncThrows = false;  // creation succeeds
    spawnState.status = 0;
    const result = validateP4Prerequisites("proj-1");
    assert.strictEqual(result, null, "expected null after successful mkdir and p4 info");
    assert.strictEqual(sideEffects.mkdirCalled, true, "expected mkdirSync to be called");
  });

  // Scenario 6: directory uncreatable — return error string
  it("returns error when directory cannot be created", () => {
    resetState();
    fsState.accessSyncThrows = true;
    fsState.mkdirSyncThrows = true;
    fsState.mkdirSyncError = "Permission denied";
    const result = validateP4Prerequisites("proj-1");
    assert.ok(result, "expected a non-null error string");
    assert.ok(
      result!.includes("could not be created"),
      `expected 'could not be created' in message, got: ${result}`
    );
    assert.ok(
      result!.includes("Permission denied"),
      `expected original error detail in message, got: ${result}`
    );
  });

  // Scenario 7: p4 info succeeds (status 0) — return null
  it("returns null when p4 info succeeds", () => {
    resetState();
    spawnState.status = 0;
    const result = validateP4Prerequisites("proj-1");
    assert.strictEqual(result, null);
  });

  // Scenario 8: p4 info fails (non-zero status) — return error string
  it("returns error when p4 info exits with non-zero status", () => {
    resetState();
    spawnState.status = 1;
    spawnState.stderr = "Perforce client error: Connect to server failed";
    const result = validateP4Prerequisites("proj-1");
    assert.ok(result, "expected a non-null error string");
    assert.ok(
      result!.includes("p4 info"),
      `expected 'p4 info' in message, got: ${result}`
    );
    assert.ok(
      result!.includes("Connect to server failed"),
      `expected stderr detail in message, got: ${result}`
    );
  });

  // Scenario 9: p4 not on PATH (status null, error.code ENOENT) — return error string
  it("returns error when p4 is not on PATH (ENOENT)", () => {
    resetState();
    spawnState.status = null;
    spawnState.stderr = "";
    spawnState.errorMessage = "spawn p4 ENOENT";
    const result = validateP4Prerequisites("proj-1");
    assert.ok(result, "expected a non-null error string");
    assert.ok(
      result!.includes("p4 info"),
      `expected 'p4 info' in message, got: ${result}`
    );
    assert.ok(
      result!.includes("spawn p4 ENOENT"),
      `expected ENOENT detail in message, got: ${result}`
    );
  });
});
