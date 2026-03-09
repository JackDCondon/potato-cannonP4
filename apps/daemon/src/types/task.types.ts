export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface TaskComment {
  id: string;
  taskId: string;
  text: string;
  createdAt: string;
}

export interface Task {
  id: string;
  ticketId: string;
  displayNumber: number;
  phase: string;
  status: TaskStatus;
  attemptCount: number;
  description: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  description: string;
  body?: string;
}
