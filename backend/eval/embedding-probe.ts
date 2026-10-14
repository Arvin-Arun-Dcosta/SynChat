/**
 * How well does an embedding tell "same topic" from "different topic"?
 *
 *   npx tsx eval/embedding-probe.ts [model-id ...]
 *
 * For every pair of messages in the same hand-labelled chat (tuning half only) that
 * both have some content, compares cosine similarity against the gold labels and
 * reports AUC: the chance that a random same-topic pair scores higher than a random
 * different-topic pair. 0.5 is useless, 1.0 is perfect.
 *
 * "centred" subtracts the chat's mean vector first. Sentence models put all text of
 * one language and register close together; romanised Hindi especially lands in one
 * tight clump. Removing what a chat's messages have in common leaves what differs
 * between them, which is the topic.
 */
import path from "node:path";
import { BACKEND_ROOT } from "../src/config.js";
import { analyseText, infoOf } from "../src/lanes/text.js";
import { loadCasual } from "./datasets.js";

const models = process.argv.slice(2).length ? process.argv.slice(2) : ["Xenova/paraphrase-multilingual-MiniLM-L12-v2"];
const HINGLISH = /dev-0[368]|dev-02/; // chats written mostly or partly in romanised Hindi

function auc(pos: number[], neg: number[]): number {
  const all = [...pos.map((v) => [v, 1] as const), ...neg.map((v) => [v, 0] as const)].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  all.forEach(([, label], i) => {
    if (label) rankSum += i + 1;
  });
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}
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
  const buckets = { all: { raw: [[], []], centred: [[], []] }, hinglish: { raw: [[], []], centred: [[], []] }, english: { raw: [[], []], centred: [[], []] } } as Record<string, Record<string, number[][]>>;
  for (const chat of chats) {
    const msgs = chat.messages.filter((m) => infoOf(analyseText(m.text), 4) >= 0.5);
    const out = await extract(msgs.map((m) => prefix + m.text), { pooling: "mean", normalize: true });
    const dim = out.dims[1] as number;
    const data = out.data as Float32Array;
    const vecs = msgs.map((_, i) => data.slice(i * dim, (i + 1) * dim));
    const mean = new Float32Array(dim);
    for (const v of vecs) for (let d = 0; d < dim; d++) mean[d]! += v[d]! / vecs.length;
    const centred = vecs.map((v) => unit(v.map((x, d) => x - mean[d]!)));
    const kind = HINGLISH.test(chat.file) ? "hinglish" : "english";
    for (let i = 0; i < msgs.length; i++) {
      for (let j = 0; j < i; j++) {
        const same = msgs[i]!.gold === msgs[j]!.gold ? 0 : 1;
        for (const bucket of ["all", kind]) {
          buckets[bucket]!.raw![same]!.push(dot(vecs[i]!, vecs[j]!));
          buckets[bucket]!.centred![same]!.push(dot(centred[i]!, centred[j]!));
        }
      }
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`\n${model}`);
  for (const [name, b] of Object.entries(buckets)) {
    for (const variant of ["raw", "centred"]) {
      const [pos, neg] = b[variant] as [number[], number[]];
      console.log(`  ${name.padEnd(9)} ${variant.padEnd(8)} AUC ${auc(pos, neg).toFixed(3)}   mean cosine: same topic ${mean(pos).toFixed(2)}, different ${mean(neg).toFixed(2)}   (${pos.length}+${neg.length} pairs)`);
    }
  }
}
