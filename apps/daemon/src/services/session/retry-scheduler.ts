type ResumeFn = (projectId: string, ticketId: string) => Promise<void>;

export interface RetryScheduler {
  schedule(projectId: string, ticketId: string, retryAt: string): void;
  cancel(ticketId: string): void;
  cancelAll(): void;
}

export function createRetryScheduler(resumeFn: ResumeFn): RetryScheduler {
  const timers = new Map<string, NodeJS.Timeout>();

  function schedule(
    projectId: string,
    ticketId: string,
    retryAt: string,
  ): void {
    // Cancel any existing timer for this ticket
    cancel(ticketId);

    const delayMs = Math.max(0, new Date(retryAt).getTime() - Date.now());
    console.log(
      `[RetryScheduler] Scheduling retry for ${ticketId} in ${Math.round(delayMs / 1000)}s`,
    );

    const timer = setTimeout(async () => {
      timers.delete(ticketId);
      try {
        await resumeFn(projectId, ticketId);
      } catch (err) {
        console.error(
          `[RetryScheduler] Failed to resume ${ticketId}: ${(err as Error).message}`,
        );
      }
    }, delayMs);

    timers.set(ticketId, timer);
  }

  function cancel(ticketId: string): void {
    const existing = timers.get(ticketId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(ticketId);
      console.log(`[RetryScheduler] Cancelled retry for ${ticketId}`);
    }
  }

  function cancelAll(): void {
    for (const [ticketId, timer] of timers) {
      clearTimeout(timer);
      console.log(`[RetryScheduler] Cancelled retry for ${ticketId}`);
    }
    timers.clear();
  }

  return { schedule, cancel, cancelAll };
}
