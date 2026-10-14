/**
 * Where is the accuracy lost? Replays the casual chats with parts of the decision
 * replaced by the right answer, to see what fixing each part would be worth.
 *
 *   npx tsx eval/oracle.ts
 */
import { assign, type HistoryMessage } from "../src/lanes/assigner.js";
import { DEFAULT_PARAMS } from "../src/lanes/params.js";
import { loadCasual } from "./datasets.js";
import { score } from "./metrics.js";
import { prepareAll } from "./run.js";
import { HISTORY, type Prepared } from "./simulate.js";

type Mode = "model" | "perfect starts" | "no false starts" | "no missed starts" | "perfect choice among lanes" | "everything right";

function replay(p: Prepared, mode: Mode) {
  const topicOf: string[] = new Array(p.n);
  let next = 0;
  for (let i = 0; i < p.n; i++) {
    const w = p.window[i]!;
    const history: HistoryMessage[] = [...w].map((j, k) => {
      const s = p.sims[i * HISTORY + k]!;
      return { senderId: p.senderId[j]!, at: p.at[j]!, topicId: topicOf[j]!, sim: Number.isNaN(s) ? null : s, text: p.text[j]!, addressees: p.addressees[j]! };
    });
    const d = assign({ senderId: p.senderId[i]!, at: p.at[i]!, text: p.text[i]!, addressees: p.addressees[i]!, hasEmbedding: p.hasEmbedding[i]! }, history, DEFAULT_PARAMS);
    const isStart = ![...w].some((j) => p.gold[j] === p.gold[i]);
    // The existing lane holding most of this message's true companions.
    const votes = new Map<string, number>();
    for (const j of w) if (p.gold[j] === p.gold[i]) votes.set(topicOf[j]!, (votes.get(topicOf[j]!) ?? 0) + 1);
    const home = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
    let choice = d.topicId;
    if (mode === "perfect starts" || mode === "everything right") {
      if (isStart) choice = null;
      else if (choice === null) choice = d.candidates[0]?.topicId ?? null;
    }
    if (mode === "no false starts" && !isStart && choice === null) choice = d.candidates[0]?.topicId ?? null;
    if (mode === "no missed starts" && isStart) choice = null;
    if ((mode === "perfect choice among lanes" || mode === "everything right") && choice !== null && home) choice = home;
    topicOf[i] = choice ?? `t${next++}`;
  }
  return { file: p.file, gold: p.gold as string[], pred: topicOf };
}

for (const split of ["dev", "test"] as const) {
  const prepared = await prepareAll(loadCasual(split));
  console.log(`\ncasual ${split}`);
  for (const mode of ["model", "no false starts", "no missed starts", "perfect starts", "perfect choice among lanes", "everything right"] as Mode[]) {
    const s = score(prepared.map((p) => replay(p, mode)));
    console.log(`  ${mode.padEnd(28)} 1-1 ${s.oneToOne.toFixed(1).padStart(5)}  VI ${s.vi.toFixed(1)}  F1 ${s.f1.toFixed(1).padStart(5)}  lanes ${s.predClusters}/${s.goldClusters}`);
  }
}
