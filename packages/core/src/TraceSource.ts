import type { TraceJournal } from "./schema";

export interface TraceSource {
  getJournal(): TraceJournal | Promise<TraceJournal>;
  subscribe(cb: (j: TraceJournal) => void): () => void;
}
