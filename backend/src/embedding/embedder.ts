import { Worker } from "node:worker_threads";
import { EMBEDDING_DIM, EMBEDDING_MODEL, MAX_EMBED_CHARS } from "./model.js";

/** Turns text into unit-length vectors. The server depends on this, not on a model. */
export interface Embedder {
  readonly model: string;
  /** Resolves with one vector per text, in order. Rejects if the model is unavailable. */
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

// The worker's code is kept as a string and started with `eval: true`. A worker
// normally needs its own file, but then the path and loader differ between `tsx`
// in development, vitest, and the compiled build. A string is the same everywhere.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let ready;
function load() {
  // The library's location is resolved by the main thread and passed in: code run
  // from a string would otherwise look for it relative to the working directory.
  ready ??= import(workerData.library).then(async ({ env, pipeline }) => {
    env.cacheDir = workerData.cacheDir;
    return pipeline("feature-extraction", workerData.model, { dtype: "q8" });
  });
  return ready;
}
parentPort.on("message", async ({ id, texts }) => {
  try {
    const extract = await load();
    const out = await extract(texts, { pooling: "mean", normalize: true });
    const data = new Float32Array(out.data);
    parentPort.postMessage({ id, dim: out.dims[1], data }, [data.buffer]);
  } catch (err) {
    ready = undefined; // let the next request try loading again
    parentPort.postMessage({ id, error: String(err && err.message || err) });
  }
});
`;

/**
 * Runs the sentence model in a worker thread, so inference (a few milliseconds per
 * message, but CPU-bound) never blocks the event loop that serves chat traffic.
 * The model is loaded on first use and downloaded to `cacheDir` the first time ever.
 */
export class WorkerEmbedder implements Embedder {
  readonly model = EMBEDDING_MODEL;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

  constructor(private readonly cacheDir: string) {}

  private start(): Worker {
    const library = import.meta.resolve("@huggingface/transformers");
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { cacheDir: this.cacheDir, model: this.model, library } });
    worker.on("message", (msg: { id: number; dim?: number; data?: Float32Array; error?: string }) => {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error || !msg.data) return w.reject(new Error(msg.error ?? "embedding failed"));
      if (msg.dim !== EMBEDDING_DIM) return w.reject(new Error(`${this.model} produces ${msg.dim}-d vectors, expected ${EMBEDDING_DIM}`));
      const vectors: Float32Array[] = [];
      for (let i = 0; i < msg.data.length; i += EMBEDDING_DIM) vectors.push(msg.data.subarray(i, i + EMBEDDING_DIM));
      w.resolve(vectors);
    });
    const fail = (err: Error) => {
      for (const w of this.waiting.values()) w.reject(err);
      this.waiting.clear();
      this.worker = null;
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (this.worker === worker) fail(new Error(`embedding worker exited (${code})`));
    });
    worker.unref();
    return worker;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return Promise.resolve([]);
    this.worker ??= this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ id, texts: texts.map((t) => t.slice(0, MAX_EMBED_CHARS)) });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }
}

/** pgvector's text form of a vector. */
export const toSqlVector = (v: Float32Array) => `[${Array.from(v, (x) => x.toFixed(6)).join(",")}]`;
