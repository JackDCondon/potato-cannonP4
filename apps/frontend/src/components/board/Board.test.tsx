import { act } from "react";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Ticket } from "@potato-cannon/shared";
import { Board } from "./Board";
import { WorkerTreeItem } from "./WorkerTreeItem";

const mockState = vi.hoisted(() => ({
  tickets: [] as Ticket[],
  updateTicketMutate: vi.fn(),
  onDragEnd: null as ((event: unknown) => void) | null,
  useTemplate: vi.fn((_: string | null) => ({
    data: {
      phases: [
        { name: "Ideas" },
        { name: "Backlog" },
        { name: "Architecture", blocksOnUnsatisfiedTiers: ["artifact-ready"] },
        { name: "Build" },
        { name: "Pull Requests" },
        { name: "Done" },
      ],
    },
  })),
  bannerProps: [] as Array<{ projectId: string; workflowId?: string | null }>,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode;
    onDragEnd?: (event: unknown) => void;
  }) => {
    mockState.onDragEnd = onDragEnd ?? null;
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
}));

vi.mock("@/hooks/queries", () => ({
  useTickets: () => ({
    data: mockState.tickets,
    isLoading: false,
    error: null,
  }),
  useProjectPhases: () => ({ data: ["Ideas", "Backlog", "Architecture", "Build", "Pull Requests", "Done"] }),
  useTemplate: (name: string | null) => mockState.useTemplate(name),
  useProjects: () => ({
    data: [{ id: "test-project", template: { name: "product-development" } }],
  }),
  useWorkflows: () => ({
    data: [
      {
        id: "workflow-default",
        projectId: "test-project",
        name: "Default",
        templateName: "product-development",
        isDefault: true,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
      {
        id: "workflow-bug",
        projectId: "test-project",
        name: "Bug",
        templateName: "bug-fix",
        isDefault: false,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
      },
    ],
  }),
  useUpdateTicket: () => ({ mutate: mockState.updateTicketMutate }),
  useToggleDisabledPhase: () => ({ mutate: vi.fn() }),
  useUpdateProject: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      boardViewMode: "kanban",
      openAddTicketModal: vi.fn(),
      showArchivedTickets: false,
    }),
}));

vi.mock("@/components/TemplateUpgradeBanner", () => ({
  TemplateUpgradeBanner: (props: { projectId: string; workflowId?: string | null }) => {
    mockState.bannerProps.push(props);
    return null;
  },
}));

vi.mock("./ArchivedSwimlane", () => ({
  ArchivedSwimlane: () => null,
}));

vi.mock("./BoardColumn", () => ({
  BoardColumn: ({
    phase,
    showAddTicket,
  }: {
    phase: string;
    showAddTicket?: boolean;
  }) => (
    <div
      data-testid={`board-column-${phase}`}
      data-show-add-ticket={String(!!showAddTicket)}
    >
      {phase}
    </div>
  ),
}));

vi.mock("./BrainstormColumn", () => ({
  BrainstormColumn: () => <div data-testid="brainstorm-column">Brainstorm</div>,
}));

vi.mock("./TicketCard", () => ({
  TicketCard: () => null,
}));

vi.mock("./ViewToggle", () => ({
  ViewToggle: () => <div data-testid="view-toggle">ViewToggle</div>,
}));

vi.mock("./TableView", () => ({
  TableView: () => null,
}));

// Mock window.matchMedia (needed for Radix UI components)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe("Board - Add Ticket button placement", () => {
  beforeEach(() => {
    mockState.tickets = [];
    mockState.updateTicketMutate.mockReset();
    mockState.onDragEnd = null;
    mockState.useTemplate.mockClear();
    mockState.bannerProps = [];
  });

  it("does not render an Add Ticket button in the board header", () => {
    render(<Board projectId="test-project" />);

    // The board header should NOT contain an "Add Ticket" button
    const addTicketButton = screen.queryByRole("button", {
      name: /add ticket/i,
    });
    expect(addTicketButton).toBeFalsy();
  });

  it("passes showAddTicket=true to the Ideas (first phase) column", () => {
    render(<Board projectId="test-project" />);

    const ideasColumns = screen.getAllByTestId("board-column-Ideas");
    const kanbanIdeasColumn = ideasColumns.find(
      (col) => col.dataset.showAddTicket !== undefined,
    );

    expect(kanbanIdeasColumn?.dataset.showAddTicket).toBe("true");
  });

  it("passes showAddTicket=false to non-Ideas columns", () => {
    render(<Board projectId="test-project" />);

    const buildColumns = screen.getAllByTestId("board-column-Build");
    const buildColumn = buildColumns.find(
      (col) => col.dataset.showAddTicket !== undefined,
    );
    expect(buildColumn?.dataset.showAddTicket).toBe("false");

    const doneColumns = screen.getAllByTestId("board-column-Done");
    const doneColumn = doneColumns.find(
      (col) => col.dataset.showAddTicket !== undefined,
    );
    expect(doneColumn?.dataset.showAddTicket).toBe("false");
  });

  it("right-aligns the board header content (justify-end)", () => {
    const { container } = render(<Board projectId="test-project" />);

    const header = container.querySelector(".px-4.py-3");
    expect(header?.className).toMatch(/justify-end/);
    expect(header?.className).not.toMatch(/justify-between/);
  });

  it("uses the selected workflow template when workflowId is provided", () => {
    render(<Board projectId="test-project" workflowId="workflow-bug" />);
    expect(mockState.useTemplate).toHaveBeenCalledWith("bug-fix");
    expect(mockState.bannerProps[0]).toEqual({
      projectId: "test-project",
      workflowId: "workflow-bug",
    });
  });

  it("passes default workflow id to upgrade banner when workflowId is not provided", () => {
    render(<Board projectId="test-project" />);
    expect(mockState.bannerProps[0]).toEqual({
      projectId: "test-project",
      workflowId: "workflow-default",
    });
  });
});

describe("Board dependency warning dialog", () => {
  beforeEach(() => {
    mockState.updateTicketMutate.mockReset();
    mockState.onDragEnd = null;
    mockState.tickets = [
      {
        id: "TKT-1",
        project: "test-project",
        title: "Blocked ticket",
        description: "",
        phase: "Ideas",
        complexity: "standard",
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: "2026-03-10T00:00:00.000Z",
        history: [],
        blockedBy: [
          {
            ticketId: "TKT-2",
            title: "Specification input",
            currentPhase: "Ideas",
            tier: "artifact-ready",
            satisfied: false,
          },
        ],
      },
    ] as Ticket[];
  });

  it("shows dependency warning and moves with overrideDependencies when confirmed", () => {
    render(<Board projectId="test-project" />);

    act(() => {
      mockState.onDragEnd?.({
        active: {
          id: "TKT-1",
          data: { current: { ticket: mockState.tickets[0] } },
        },
        over: { id: "Architecture" },
      });
    });

    expect(screen.queryByText(/dependency warning/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /move anyway/i }));

    expect(mockState.updateTicketMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        ticketId: "TKT-1",
        updates: expect.objectContaining({
          phase: "Architecture",
          overrideDependencies: true,
        }),
      }),
    );
  });

  it("does not move when dependency warning is cancelled", () => {
    render(<Board projectId="test-project" />);

    act(() => {
      mockState.onDragEnd?.({
        active: {
          id: "TKT-1",
          data: { current: { ticket: mockState.tickets[0] } },
        },
        over: { id: "Architecture" },
      });
    });

    expect(screen.queryByText(/dependency warning/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockState.updateTicketMutate).not.toHaveBeenCalled();
  });
});

describe("WorkerTreeItem tier terminology", () => {
  it("renders a tier badge for single-tier agent config", () => {
    const onAgentClick = vi.fn();
    render(
      <WorkerTreeItem
        node={{ id: "implementer", type: "agent", agentType: "builder-agent", modelTier: "high" }}
        depth={0}
        isLastChild={true}
        onAgentClick={onAgentClick}
      />,
    );

    expect(screen.getByText("Tier: high")).toBeTruthy();

    fireEvent.click(screen.getByText("Builder Agent").closest('[role="button"]') as HTMLElement);
    expect(onAgentClick).toHaveBeenCalledWith("builder-agent", "Builder Agent", "high");
  });

  it("renders mapped modelTier values and passes the tier label on click", () => {
    const onAgentClick = vi.fn();
    render(
      <WorkerTreeItem
        node={{
          id: "reviewer",
          type: "agent",
          agentType: "verify-quality-agent",
          modelTier: { simple: "low", standard: "mid", complex: "high" },
        }}
        depth={0}
        isLastChild={true}
        onAgentClick={onAgentClick}
      />,
    );

    expect(screen.getByText("Tier: low/mid/high")).toBeTruthy();

    fireEvent.click(screen.getByText("Verify Quality Agent").closest('[role="button"]') as HTMLElement);
    expect(onAgentClick).toHaveBeenCalledWith("verify-quality-agent", "Verify Quality Agent", "low/mid/high");
  });
});
