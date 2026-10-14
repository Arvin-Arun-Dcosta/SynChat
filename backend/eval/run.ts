/**
 * Offline evaluation of the lane assigner.
 *
 *   npm run eval            score the shipped parameters on every dataset
 *   npm run eval -- --params eval/results/irc-only.json
 *
 * Reads eval/data (see `npm run eval:data`) and eval/casual. Prints the standard
 * metrics plus two baselines for scale.
 */
import fs from "node:fs";
import { DEFAULT_PARAMS, type LaneParams } from "../src/lanes/params.js";
import { loadCasual, loadIrc, type Stream } from "./datasets.js";
import { embedAll } from "./embed.js";
import { formatScores, score, type Clustering } from "./metrics.js";
import { prepare, simulate, type Prepared } from "./simulate.js";

export async function prepareAll(streams: Stream[]): Promise<Prepared[]> {
  const texts = streams.flatMap((s) => s.messages.filter((m) => !m.system && m.text.trim()).map((m) => m.text));
  const vectors = await embedAll(texts);
  return streams.map((s) => prepare(s, vectors));
}

export const evaluate = (prepared: Prepared[], params: LaneParams) => score(prepared.map((p) => simulate(p, params)));

/**
 * Baselines for scale. "Previous" links every message to the one before it, so each
 * file is one conversation (system lines stay on their own); it is the baseline of the
 * same name in Kummerfeld et al. (2019), which reports VI 66.1 and 1-1 27.6 for it on
 * the IRC test set. Reproducing those two numbers checks this file's metric code.
 */
function baselines(prepared: Prepared[]): { previous: Clustering[]; allSeparate: Clustering[] } {
  const scored = prepared.map((p) => {
    const keep = p.gold.map((g, i) => (g === null ? -1 : i)).filter((i) => i >= 0);
    return { file: p.file, gold: keep.map((i) => p.gold[i]!), system: keep.map((i) => p.system[i]!) };
  });
  return {
    previous: scored.map((s) => ({ file: s.file, gold: s.gold, pred: s.gold.map((_, i) => (s.system[i] ? `sys${i}` : "one")) })),
    allSeparate: scored.map((s) => ({ file: s.file, gold: s.gold, pred: s.gold.map((_, i) => `m${i}`) })),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const paramsFile = argv[argv.indexOf("--params") + 1];
  const params: LaneParams = argv.includes("--params") && paramsFile ? { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(paramsFile, "utf8")) } : DEFAULT_PARAMS;
  const sets: [string, Stream[]][] = [
    ["Casual chats, tuning half (dev)", loadCasual("dev")],
    ["Casual chats, held out (test)", loadCasual("test")],
    ["Ubuntu IRC dev", loadIrc("dev")],
    ["Ubuntu IRC test", loadIrc("test")],
  ];
  console.log(argv.includes("--params") ? `Parameters: ${paramsFile}` : "Parameters: shipped defaults (src/lanes/params.ts)");
  for (const [label, streams] of sets) {
    const prepared = await prepareAll(streams);
    console.log(formatScores(label, evaluate(prepared, params)));
    if (argv.includes("--baselines")) {
      const b = baselines(prepared);
      console.log(formatScores("   baseline: link to previous", score(b.previous)));
      console.log(formatScores("   baseline: every message alone", score(b.allSeparate)));
    }
    if (argv.includes("--per-file")) {
      for (const p of prepared) console.log(formatScores(`   ${p.file}`, score([simulate(p, params)])));
    }
  }
}

if (process.argv[1]?.endsWith("run.ts")) await main();
