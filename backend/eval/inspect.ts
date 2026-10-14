/**
 * Print one evaluation stream with the gold label and the assigner's decision side by
 * side, to see where and why it goes wrong.
 *
 *   npx tsx eval/inspect.ts casual/dev-01            (substring of the file name)
 *   npx tsx eval/inspect.ts dev/2004-11-15 --errors  (only lines that look wrong)
 */
import { assign, type HistoryMessage } from "../src/lanes/assigner.js";
import fs from "node:fs";
import { DEFAULT_PARAMS as SHIPPED, type LaneParams } from "../src/lanes/params.js";
import { loadCasual, loadIrc } from "./datasets.js";
import { prepareAll } from "./run.js";
import { HISTORY, simulate } from "./simulate.js";

const want = process.argv[2] ?? "casual/dev-01";
const onlyErrors = process.argv.includes("--errors");
const paramsAt = process.argv.indexOf("--params");
const DEFAULT_PARAMS: LaneParams = paramsAt > 0 ? { ...SHIPPED, ...JSON.parse(fs.readFileSync(process.argv[paramsAt + 1]!, "utf8")) } : SHIPPED;
const streams = [...loadCasual("dev"), ...loadCasual("test"), ...loadIrc("dev"), ...loadIrc("test")].filter((s) => s.file.includes(want));
if (streams.length === 0) throw new Error(`no stream matches ${want}`);
const stream = streams[0]!;
const [p] = await prepareAll([stream]);
const result = simulate(p!, DEFAULT_PARAMS);

// Name each predicted topic after the gold label most of its messages carry.
const votes = new Map<string, Map<string, number>>();
for (let i = 0; i < p!.n; i++) {
  const g = p!.gold[i];
  if (g == null) continue;
  const key = result.topicOf[i]!;
  const v = votes.get(key) ?? votes.set(key, new Map<string, number>()).get(key)!;
  v.set(g, (v.get(g) ?? 0) + 1);
}
const majority = new Map<string, string>([...votes].map(([t, v]): [string, string] => [t, [...v].sort((a, b) => b[1] - a[1])[0]![0]]));

console.log(stream.file);
for (let i = 0; i < p!.n; i++) {
  const g = p!.gold[i];
  if (g == null || p!.system[i]) continue;
  const t = result.topicOf[i]!;
  const wrong = majority.get(t) !== g;
  if (onlyErrors && !wrong) continue;
  const w = p!.window[i]!;
  const history: HistoryMessage[] = [...w].map((j, k) => {
    const s = p!.sims[i * HISTORY + k]!;
    return { senderId: p!.senderId[j]!, at: p!.at[j]!, topicId: result.topicOf[j]!, sim: Number.isNaN(s) ? null : s, text: p!.text[j]!, addressees: p!.addressees[j]! };
  });
  const d = assign({ senderId: p!.senderId[i]!, at: p!.at[i]!, text: p!.text[i]!, addressees: p!.addressees[i]!, hasEmbedding: p!.hasEmbedding[i]! }, history, DEFAULT_PARAMS);
  const f = (x: number) => x.toFixed(2);
  const top = d.candidates
    .slice(0, 2)
    .map((c) => {
      const why = Object.entries(c.features)
        .map(([name, value]) => [name, value * DEFAULT_PARAMS.topic[name as keyof typeof c.features]] as const)
        .filter(([, v]) => Math.abs(v) >= 0.15)
        .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
        .slice(0, 4)
        .map(([name, v]) => `${name} ${v > 0 ? "+" : ""}${f(v)}`)
        .join(", ");
      return `${c.topicId}(${majority.get(c.topicId) ?? "?"}) ${f(c.score)} [${why}]`;
    })
    .join("  ");
  console.log(
    `${wrong ? "✗" : " "} ${String(g).padEnd(9).slice(0, 9)} → ${t.padEnd(5)} ${stream.messages[i]!.senderId.padEnd(8).slice(0, 8)} ${stream.messages[i]!.text.slice(0, 44).padEnd(44)} | info ${f(d.info)} new ${f(d.newScore)} ${d.topicId ? "" : "NEW "}| ${top}`,
  );
}
