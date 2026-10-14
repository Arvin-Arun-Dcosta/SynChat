import { centredCosine, shrunkMean } from "../src/embedding/centre.js";
import { assign, type HistoryMessage } from "../src/lanes/assigner.js";
import type { LaneParams } from "../src/lanes/params.js";
import { addresseesOf, analyseText, type TextFeatures } from "../src/lanes/text.js";
import type { Stream } from "./datasets.js";
import type { Clustering } from "./metrics.js";

/** How many earlier messages the assigner is shown. The server uses the same window. */
export const HISTORY = 200;

/** A stream with everything that does not depend on the parameters worked out once. */
export interface Prepared {
  file: string;
  n: number;
  senderId: string[];
  at: number[];
  system: boolean[];
  gold: (string | null)[];
  /** Known cluster ids, including linked warm-up messages (see StreamMessage.cluster). */
  cluster: (string | null)[];
  text: TextFeatures[];
  addressees: string[][];
  hasEmbedding: boolean[];
  /** sims[i * HISTORY + k] = centred cosine of message i and the k-th message of its window. */
  sims: Float32Array;
  /** For message i, the indexes of the up-to-HISTORY earlier non-system messages, oldest first. */
  window: Int32Array[];
}

export function prepare(stream: Stream, vectors: Map<string, Float32Array>): Prepared {
  const n = stream.messages.length;
  const text = stream.messages.map((m) => analyseText(m.text));
  const emb = stream.messages.map((m) => (m.system || !m.text.trim() ? null : (vectors.get(m.text) ?? null)));
  const sims = new Float32Array(n * HISTORY).fill(NaN);
  const window: Int32Array[] = [];
  const seen: number[] = [];
  // Only people who have spoken so far can be addressed (as in the app, where only
  // members can be). Names are matched against speakers within the stream.
  const known = new Map<string, { id: string; names: string[] }>();
  const addressees: string[][] = [];
  const byId = new Map(stream.people.map((p) => [p.id, p]));
  for (let i = 0; i < n; i++) {
    const m = stream.messages[i]!;
    const w = seen.slice(-HISTORY);
    window.push(Int32Array.from(w));
    addressees.push(m.system ? [] : addresseesOf(m.text, m.senderId, [...known.values()]));
    if (m.system) continue;
    const e = emb[i];
    if (e) {
      // Centre on the mean of the window, exactly as the server does in SQL.
      const others = [...w].map((j) => emb[j]).filter((v): v is Float32Array => v != null);
      const mean = shrunkMean(others, e.length);
      for (let k = 0; k < w.length; k++) {
        const other = emb[w[k]!];
        if (other) sims[i * HISTORY + k] = centredCosine(e, other, mean);
      }
    }
    seen.push(i);
    const person = byId.get(m.senderId);
    if (person) known.set(person.id, person);
  }
  return {
    file: stream.file,
    n,
    senderId: stream.messages.map((m) => m.senderId),
    at: stream.messages.map((m) => m.at),
    system: stream.messages.map((m) => m.system),
    gold: stream.messages.map((m) => m.gold),
    cluster: stream.messages.map((m) => m.cluster),
    text,
    addressees,
    hasEmbedding: emb.map((e) => e !== null),
    sims,
    window,
  };
}

/**
 * Replay a stream through the assigner, one message at a time, exactly as the server
 * does: each message sees only earlier messages and their already-decided topics.
 */
export function simulate(p: Prepared, params: LaneParams): Clustering & { topicOf: string[] } {
  const topicOf: string[] = new Array(p.n);
  let nextTopic = 0;
  for (let i = 0; i < p.n; i++) {
    if (p.system[i]) {
      topicOf[i] = `sys${i}`;
      continue;
    }
    const w = p.window[i]!;
    const history: HistoryMessage[] = new Array(w.length);
    for (let k = 0; k < w.length; k++) {
      const j = w[k]!;
      const s = p.sims[i * HISTORY + k]!;
      history[k] = { senderId: p.senderId[j]!, at: p.at[j]!, topicId: topicOf[j]!, sim: Number.isNaN(s) ? null : s, text: p.text[j]!, addressees: p.addressees[j]! };
    }
    const decision = assign(
      { senderId: p.senderId[i]!, at: p.at[i]!, text: p.text[i]!, addressees: p.addressees[i]!, hasEmbedding: p.hasEmbedding[i]! },
      history,
      params,
    );
    topicOf[i] = decision.topicId ?? `t${nextTopic++}`;
  }
  const gold: string[] = [];
  const pred: string[] = [];
  for (let i = 0; i < p.n; i++) {
    if (p.gold[i] === null) continue;
    gold.push(p.gold[i]!);
    pred.push(topicOf[i]!);
  }
  return { file: p.file, gold, pred, topicOf };
}
