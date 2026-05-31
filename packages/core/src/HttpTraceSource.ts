import type { TraceJournal } from "./schema";
import type { TraceSource } from "./TraceSource";

export interface HttpClient {
  get<T>(path: string): Promise<T>;
}

const EMPTY_JOURNAL: TraceJournal = { runs: [] };

/**
 * Polling TraceSource. Fetches the journal from an HTTP endpoint and re-polls on
 * a fixed interval. Errors are swallowed (the last good cache is kept) so a
 * transient backend hiccup never tears down subscribers.
 */
export class HttpTraceSource implements TraceSource {
  private cache: TraceJournal = EMPTY_JOURNAL;

  constructor(
    private readonly client: HttpClient,
    private readonly endpoint: string,
    private readonly refreshMs: number = 4000,
  ) {}

  async getJournal(): Promise<TraceJournal> {
    this.cache = await this.client.get<TraceJournal>(this.endpoint);
    return this.cache;
  }

  subscribe(cb: (j: TraceJournal) => void): () => void {
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const journal = await this.getJournal();
        if (!stopped) cb(journal);
      } catch {
        // swallow: keep the last cached journal, retry on the next tick
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), this.refreshMs);

    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }
}
