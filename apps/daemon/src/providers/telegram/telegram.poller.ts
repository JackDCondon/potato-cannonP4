// src/providers/telegram/telegram.poller.ts

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export class TelegramPoller {
  private running = false;
  private offset = 0;
  private abortController: AbortController | null = null;
  private backoffMs = BACKOFF_MIN_MS;

  constructor(
    private botToken: string,
    private onUpdate: (update: unknown) => Promise<void>
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const updates = await this.getUpdates();

        // Successful poll — reset backoff
        this.backoffMs = BACKOFF_MIN_MS;

        for (const update of updates) {
          const u = update as { update_id: number };
          this.offset = u.update_id + 1;

          try {
            await this.onUpdate(update);
          } catch (error) {
            console.error('[TelegramPoller] Error handling update:', (error as Error).message);
          }
        }
      } catch (error) {
        const err = error as Error & { cause?: { code?: string; message?: string } };
        if (err.name !== 'AbortError') {
          const cause = err.cause?.code ?? err.cause?.message ?? '';
          console.error(`[TelegramPoller] Poll error: ${err.message}${cause ? ` (${cause})` : ''} — retrying in ${this.backoffMs / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, this.backoffMs));
          this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        }
      }
    }
  }

  private async getUpdates(): Promise<unknown[]> {
    const params = new URLSearchParams({
      timeout: '30',
      offset: this.offset.toString(),
    });

    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/getUpdates?${params}`,
      { signal: this.abortController?.signal }
    );

    const result = await response.json();
    if (!result.ok) {
      throw new Error(`Telegram API error: ${result.description}`);
    }

    return result.result;
  }
}
