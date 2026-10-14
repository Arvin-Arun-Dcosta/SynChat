/**
 * With perfect knowledge of the earlier messages' topics, how often does meaning
 * alone pick the right lane for the next message? An upper bound on what the
 * semantic part of the assigner can contribute, for different ways of comparing a
 * message with a topic. Tuning half of the casual chats only.
 *
 *   npx tsx eval/topic-probe.ts [model-id ...]
 */
import path from "node:path";
import { BACKEND_ROOT } from "../src/config.js";
import { analyseText, infoOf } from "../src/lanes/text.js";
import { loadCasual } from "./datasets.js";

const models = process.argv.slice(2).length ? process.argv.slice(2) : ["Xenova/paraphrase-multilingual-MiniLM-L12-v2"];
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const unit = (v: Float32Array) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const { env, pipeline } = await import("@huggingface/transformers");
env.cacheDir = path.join(BACKEND_ROOT, ".cache", "models");
const chats = loadCasual("dev");

for (const model of models) {
  const extract = await pipeline("feature-extraction", model, { dtype: "q8" });
  const prefix = model.includes("e5") ? "query: " : "";
  const embed = async (texts: string[]) => {
    const out = await extract(texts.map((t) => prefix + t), { pooling: "mean", normalize: true });
    const dim = out.dims[1] as number;
    return texts.map((_, i) => (out.data as Float32Array).slice(i * dim, (i + 1) * dim));
  };
  const methods = ["max pair", "mean top-3", "centroid", "centred max", "centred top-3", "centred centroid", "topic as one text", "words in common"];
  const right: Record<string, number> = Object.fromEntries(methods.map((m) => [m, 0]));
  let trials = 0;
  let chance = 0;

  for (const chat of chats) {
    const msgs = chat.messages.map((m) => ({ ...m, f: analyseText(m.text) })).filter((m) => infoOf(m.f, 4) >= 0.5);
    const vecs = await embed(msgs.map((m) => m.text));
    for (let i = 1; i < msgs.length; i++) {
      // Topics seen so far, from earlier substantial messages only.
      const earlier = new Map<string, number[]>();
      for (let j = 0; j < i; j++) (earlier.get(msgs[j]!.gold!) ?? earlier.set(msgs[j]!.gold!, []).get(msgs[j]!.gold!)!).push(j);
      if (!earlier.has(msgs[i]!.gold!) || earlier.size < 2) continue; // nothing to choose between
      trials++;
      chance += 1 / earlier.size;
      // Centre on the mean of everything said so far in the chat.
      const mean = new Float32Array(vecs[0]!.length);
      for (let j = 0; j < i; j++) for (let d = 0; d < mean.length; d++) mean[d]! += vecs[j]![d]! / i;
      const c = (v: Float32Array) => unit(v.map((x, d) => x - mean[d]!));
      const qc = c(vecs[i]!);
      const docs = await embed([...earlier.values()].map((idx) => idx.slice(-8).map((j) => msgs[j]!.text).join(". ")));
      const words = new Set(msgs[i]!.f.content);
      const scores: Record<string, [string, number][]> = Object.fromEntries(methods.map((m) => [m, []]));
      [...earlier.entries()].forEach(([topic, idx], t) => {
        const raw = idx.map((j) => dot(vecs[i]!, vecs[j]!)).sort((a, b) => b - a);
        const cen = idx.map((j) => dot(qc, c(vecs[j]!))).sort((a, b) => b - a);
        const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        const centroid = new Float32Array(mean.length);
        for (const j of idx) for (let d = 0; d < mean.length; d++) centroid[d]! += vecs[j]![d]!;
        const shared = new Set(idx.flatMap((j) => msgs[j]!.f.content).filter((w) => words.has(w))).size;
        scores["max pair"]!.push([topic, raw[0]!]);
        scores["mean top-3"]!.push([topic, avg(raw.slice(0, 3))]);
        scores["centroid"]!.push([topic, dot(vecs[i]!, unit(centroid))]);
        scores["centred max"]!.push([topic, cen[0]!]);
        scores["centred top-3"]!.push([topic, avg(cen.slice(0, 3))]);
        scores["centred centroid"]!.push([topic, dot(qc, c(unit(centroid)))]);
        scores["topic as one text"]!.push([topic, dot(vecs[i]!, docs[t]!)]);
        scores["words in common"]!.push([topic, shared + raw[0]! * 0.001]);
      });
      for (const m of methods) {
        const best = scores[m]!.sort((a, b) => b[1] - a[1])[0]![0];
        if (best === msgs[i]!.gold) right[m]!++;
      }
    }
  }
  console.log(`\n${model}: picks the right lane out of the lanes so far (${trials} substantial messages; chance ${((100 * chance) / trials).toFixed(0)}%)`);
  for (const m of methods) console.log(`  ${m.padEnd(20)} ${((100 * right[m]!) / trials).toFixed(1)}%`);
}
