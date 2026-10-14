/**
 * Where does the assigner go wrong when it is shown the true history?
 *
 *   npx tsx eval/errors.ts [--params file.json] [--set casual|irc]
 *
 * Splits its mistakes on the dev half into three kinds and lists examples:
 *   missed start   the message opened a topic, the model joined an existing one
 *   false start    the message continued a topic, the model opened a new one
 *   wrong topic    the model joined a topic, but not the right one
 */
import fs from "node:fs";
import { assign, type HistoryMessage } from "../src/lanes/assigner.js";
import { DEFAULT_PARAMS, type LaneParams } from "../src/lanes/params.js";
import { loadCasual, loadIrc } from "./datasets.js";
import { prepareAll } from "./run.js";
import { HISTORY } from "./simulate.js";

const at = process.argv.indexOf("--params");
const params: LaneParams = at > 0 ? { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(process.argv[at + 1]!, "utf8")) } : DEFAULT_PARAMS;
const set = process.argv.includes("irc") ? "irc" : "casual";
// The test half may be counted (--split test) but its examples are never listed:
// it stays unseen so that it cannot leak into design decisions.
const split = process.argv.includes("test") ? "test" : "dev";
const streams = set === "irc" ? loadIrc(split) : loadCasual(split);
const prepared = await prepareAll(streams);

const kinds = { "missed start": [] as string[], "false start": [] as string[], "wrong topic": [] as string[] };
let total = 0;
let starts = 0;
prepared.forEach((p, s) => {
  for (let i = 0; i < p.n; i++) {
    if (p.gold[i] == null || p.system[i]) continue;
    const w = p.window[i]!;
    const history: HistoryMessage[] = [];
    for (let k = 0; k < w.length; k++) {
      const j = w[k]!;
      if (p.cluster[j] == null) continue;
      const sim = p.sims[i * HISTORY + k]!;
      history.push({ senderId: p.senderId[j]!, at: p.at[j]!, topicId: p.cluster[j]!, sim: Number.isNaN(sim) ? null : sim, text: p.text[j]!, addressees: p.addressees[j]! });
    }
    const d = assign({ senderId: p.senderId[i]!, at: p.at[i]!, text: p.text[i]!, addressees: p.addressees[i]!, hasEmbedding: p.hasEmbedding[i]! }, history, params);
    const isStart = !history.some((h) => h.topicId === p.gold[i]);
    total++;
    if (isStart) starts++;
    const line = `${p.file.split("/")[1]!.slice(0, 10)} ${p.senderId[i]!.padEnd(7).slice(0, 7)} ${streams[s]!.messages[i]!.text.slice(0, 52).padEnd(52)} info ${d.info.toFixed(2)} best ${d.score.toFixed(2)} new ${d.newScore.toFixed(2)}`;
    if (isStart && d.topicId !== null) kinds["missed start"].push(line);
    else if (!isStart && d.topicId === null) kinds["false start"].push(line);
    else if (!isStart && d.topicId !== p.gold[i]) kinds["wrong topic"].push(line);
  }
});
const wrong = Object.values(kinds).reduce((n, k) => n + k.length, 0);
console.log(`${set} ${split}: ${total} decisions, ${starts} topic starts, ${wrong} wrong (${((100 * (total - wrong)) / total).toFixed(1)}% right)`);
for (const [kind, lines] of Object.entries(kinds)) {
  console.log(`\n${kind}: ${lines.length}`);
  if (split === "dev") for (const l of lines.slice(0, Number(process.env.SHOW ?? 40))) console.log(`  ${l}`);
}
