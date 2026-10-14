/**
 * A keyed serial queue: jobs with the same key run one at a time, in the order they
 * were added; jobs with different keys run concurrently.
 *
 * Lane assignment uses the conversation id as the key, so a conversation's messages
 * are assigned strictly in order and never race each other.
 *
 * This one lives in process memory, which is right for a single server. The interface
 * is the part to keep: a Redis-backed queue (e.g. BullMQ with one group per key)
 * implements the same two methods. Jobs must therefore be safe to run again after a
 * crash; see LaneService.recover().
 */
export interface KeyedQueue {
  enqueue(key: string, job: () => Promise<void>): void;
  /** Resolves when everything queued so far has finished. Used by tests and shutdown. */
  idle(): Promise<void>;
}

export class InProcessQueue implements KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (key: string, err: unknown) => void = (key, err) => console.error(`[queue] job for ${key} failed:`, err)) {}

  enqueue(key: string, job: () => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(job).catch((err) => this.onError(key, err));
    this.tails.set(key, next);
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
  }

  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}
