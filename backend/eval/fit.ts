/**
 * Fit the lane assigner's weights to labelled conversations.
 *
 *   npm run eval:fit                         product weights (casual chats + IRC)
 *   npm run eval:fit -- --objective irc      IRC only, to see the benchmark ceiling
 *   npm run eval:fit -- --objective casual
 *
 * The assigner is a ranking model: softmax over "join topic T" for every recent
 * topic, plus "start a new topic". For each labelled message we build the features
 * from the *true* topics of the earlier messages and maximise the log-likelihood of
 * the true choice (with a little L2 so no weight runs away on a few hundred examples).
 *
 * Only the dev halves are read. The result is printed and written to
 * eval/results/<objective>.json; the shipped copy lives in src/lanes/params.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { featurise, type HistoryMessage } from "../src/lanes/assigner.js";
import { DEFAULT_CONSTANTS, NEW_FEATURES, TOPIC_FEATURES, type LaneParams, type LaneWeights } from "../src/lanes/params.js";
import { EVAL_DIR, loadCasual, loadIrc } from "./datasets.js";
import { formatScores, score } from "./metrics.js";
import { prepareAll } from "./run.js";
import { HISTORY, simulate, type Prepared } from "./simulate.js";

type Objective = "joint" | "casual" | "irc";
const RESULTS = path.join(EVAL_DIR, "results");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const T = TOPIC_FEATURES.length;
const N = NEW_FEATURES.length;

/** One labelled decision: the options that were open, and which one was right. */
interface Example {
  /** Feature vectors of the candidate topics (each of length T). */
  topics: Float64Array[];
  fresh: Float64Array;
  /** Index into `topics` of the right one, or -1 if the message started a new topic. */
  label: number;
  weight: number;
}

/**
 * Labelled decisions from one stream.
 *
 * With no `assigned`, history carries the true topics ("teacher forcing"): the model
 * learns the right choice in a world where everything before was right.
 *
 * With `assigned` (the topics the model itself gave on a replay), history carries
 * those instead, mistakes included, and the right choice is the existing lane that
 * holds most of the message's true companions, or a new lane if none does. This is
 * what the model actually faces in use, where one early slip leaves lanes mixed.
 */
function examples(p: Prepared, assigned?: string[]): Example[] {
  const out: Example[] = [];
  for (let i = 0; i < p.n; i++) {
    if (p.gold[i] == null || p.system[i]) continue;
    const w = p.window[i]!;
    const history: HistoryMessage[] = [];
    const companions = new Map<string, number>();
    for (let k = 0; k < w.length; k++) {
      const j = w[k]!;
      const topicId = assigned ? assigned[j] : p.cluster[j];
      if (topicId == null) continue; // an unannotated warm-up line: its topic is unknown
      const s = p.sims[i * HISTORY + k]!;
      history.push({ senderId: p.senderId[j]!, at: p.at[j]!, topicId, sim: Number.isNaN(s) ? null : s, text: p.text[j]!, addressees: p.addressees[j]! });
      if (p.cluster[j] === p.gold[i]) companions.set(topicId, (companions.get(topicId) ?? 0) + 1);
    }
    const home = [...companions].sort((a, b) => b[1] - a[1])[0]?.[0];
    const f = featurise({ senderId: p.senderId[i]!, at: p.at[i]!, text: p.text[i]!, addressees: p.addressees[i]!, hasEmbedding: p.hasEmbedding[i]! }, history, DEFAULT_CONSTANTS);
    out.push({
      topics: f.candidates.map((c) => Float64Array.from(TOPIC_FEATURES.map((name) => c.features[name]))),
      fresh: Float64Array.from(NEW_FEATURES.map((name) => f.fresh[name])),
      label: home === undefined ? -1 : f.candidates.findIndex((c) => c.topicId === home),
      weight: 1,
    });
  }
  return out;
}

/** Negative log-likelihood and its gradient at `w` (topic weights, then new-topic weights). */
function loss(data: Example[], w: Float64Array, l2: number, prior: Float64Array): { value: number; grad: Float64Array; accuracy: number } {
  const grad = new Float64Array(T + N);
  let value = 0;
  let correct = 0;
  let total = 0;
  for (const ex of data) {
    const scores = new Float64Array(ex.topics.length + 1);
    for (let c = 0; c < ex.topics.length; c++) {
      let s = 0;
      for (let k = 0; k < T; k++) s += w[k]! * ex.topics[c]![k]!;
      scores[c] = s;
    }
    let fresh = 0;
    for (let k = 0; k < N; k++) fresh += w[T + k]! * ex.fresh[k]!;
    scores[ex.topics.length] = fresh;
    let max = -Infinity;
    let arg = 0;
    for (let c = 0; c < scores.length; c++) {
      if (scores[c]! > max) {
        max = scores[c]!;
        arg = c;
      }
    }
    let z = 0;
    for (let c = 0; c < scores.length; c++) z += Math.exp(scores[c]! - max);
    const truth = ex.label < 0 ? ex.topics.length : ex.label;
    value -= ex.weight * (scores[truth]! - max - Math.log(z));
    total += ex.weight;
    if (arg === truth) correct += ex.weight;
    for (let c = 0; c < scores.length; c++) {
      const d = ex.weight * (Math.exp(scores[c]! - max) / z - (c === truth ? 1 : 0));
      if (c < ex.topics.length) for (let k = 0; k < T; k++) grad[k]! += d * ex.topics[c]![k]!;
      else for (let k = 0; k < N; k++) grad[T + k]! += d * ex.fresh[k]!;
    }
  }
  // L2 pull toward the prior (zero unless given) on everything except the new-topic bias.
  for (let k = 0; k < T + N; k++) {
    if (k === T) continue;
    const d = w[k]! - prior[k]!;
    value += 0.5 * l2 * total * d * d;
    grad[k]! += l2 * total * d;
  }
  return { value: value / total, grad: grad.map((g) => g / total), accuracy: correct / total };
}

function fit(data: Example[], l2: number, steps: number, prior: Float64Array): { w: Float64Array; value: number; accuracy: number } {
  const w = Float64Array.from(prior);
  // Adam.
  const m = new Float64Array(w.length);
  const v = new Float64Array(w.length);
  const [b1, b2, lr] = [0.9, 0.999, 0.05];
  let last = loss(data, w, l2, prior);
  for (let t = 1; t <= steps; t++) {
    for (let k = 0; k < w.length; k++) {
      m[k] = b1 * m[k]! + (1 - b1) * last.grad[k]!;
      v[k] = b2 * v[k]! + (1 - b2) * last.grad[k]! ** 2;
      w[k]! -= (lr * (m[k]! / (1 - b1 ** t))) / (Math.sqrt(v[k]! / (1 - b2 ** t)) + 1e-8);
    }
    last = loss(data, w, l2, prior);
  }
  return { w, value: last.value, accuracy: last.accuracy };
}

const toWeights = (w: Float64Array): LaneWeights => ({
  topic: Object.fromEntries(TOPIC_FEATURES.map((n, k) => [n, Math.round(w[k]! * 100) / 100])) as LaneWeights["topic"],
  fresh: Object.fromEntries(NEW_FEATURES.map((n, k) => [n, Math.round(w[T + k]! * 100) / 100])) as LaneWeights["fresh"],
});

interface Options {
  l2: number;
  /** How many times over a topic start counts in the likelihood. */
  newWeight: number;
  /** Share of the total weight given to casual chats when IRC is used too. */
  casualShare: number;
  steps: number;
  /** Rounds of learning from the model's own replayed decisions (0 = true history only). */
  rounds: number;
  /**
   * Weights to regularise toward instead of zero. Used to fit the casual weights
   * starting from the IRC ones: IRC has far more labelled decisions, so where the few
   * hundred casual examples say little, the general conversational structure learned
   * from IRC is kept. Features that only exist in a crowd are zeroed first.
   */
  prior: Float64Array;
}

/** One number to climb when replaying: agreement first, exact lanes as a tie-breaker. */
const composite = (x: ReturnType<typeof score>) => 0.45 * x.oneToOne + 0.4 * x.vi + 0.15 * x.f1;

function replayScore(casual: Prepared[], irc: Prepared[], params: LaneParams, casualShare: number): number {
  const parts: number[] = [];
  // Casual chats are scored one by one and averaged, so no single chat dominates.
  if (casual.length) parts.push(casual.map((p) => composite(score([simulate(p, params)]))).reduce((a, b) => a + b, 0) / casual.length);
  if (irc.length) parts.push(composite(score(irc.map((p) => simulate(p, params)))));
  return parts.length === 2 ? casualShare * parts[0]! + (1 - casualShare) * parts[1]! : parts[0]!;
}

/** Fit weights on the given conversations, then calibrate the new-topic bias by replay. */
function train(casual: Prepared[], irc: Prepared[], o: Options, log: (line: string) => void = () => {}): LaneParams {
  let params = trainOnce(casual, irc, o, undefined, log);
  // Rounds of learning from the model's own replays (see `examples`). Each round adds
  // the decisions it faced with its current weights to the ones seen so far.
  const replays: Map<Prepared, string[]>[] = [];
  for (let round = 1; round <= o.rounds; round++) {
    replays.push(new Map([...casual, ...irc].map((p) => [p, simulate(p, params).topicOf])));
    params = trainOnce(casual, irc, o, replays, (line) => log(`round ${round}: ${line}`));
  }
  return params;
}

function trainOnce(casual: Prepared[], irc: Prepared[], o: Options, replays: Map<Prepared, string[]>[] | undefined, log: (line: string) => void): LaneParams {
  const gather = (set: Prepared[]) => set.flatMap((p) => [...examples(p), ...(replays ?? []).flatMap((r) => examples(p, r.get(p)))]);
  const casualExamples = gather(casual);
  const ircExamples = gather(irc);
  // Each domain gets a fixed share of the total weight, however many messages it has.
  if (casualExamples.length && ircExamples.length) {
    for (const e of casualExamples) e.weight = o.casualShare / casualExamples.length;
    for (const e of ircExamples) e.weight = (1 - o.casualShare) / ircExamples.length;
  }
  const data = [...casualExamples, ...ircExamples];
  // Missing the start of a topic costs far more than one misplaced message: every
  // later message of that topic then has nowhere right to go. But starts are rare
  // (a few percent of messages), so plain likelihood under-weights them. Count each
  // one several times over.
  for (const e of data) if (e.label < 0) e.weight *= o.newWeight;
  const share = (xs: Example[]) => (xs.length ? ((100 * xs.filter((e) => e.label < 0).length) / xs.length).toFixed(0) + "%" : "-");
  log(`${casualExamples.length} casual + ${ircExamples.length} IRC decisions (topic starts: ${share(casualExamples)} / ${share(ircExamples)})`);

  const { w, value, accuracy } = fit(data, o.l2, o.steps, o.prior);
  log(`log-loss ${value.toFixed(4)}, right choice given true history: ${(100 * accuracy).toFixed(1)}%`);

  // The weights were fitted with the true history in view. Replayed from scratch the
  // model lives with its own earlier decisions, so calibrate the one number that
  // trades "join" against "start new", the new-topic bias, on replayed scores.
  const fitted = toWeights(w);
  let bestShift = 0;
  let bestValue = -Infinity;
  for (let shift = -2; shift <= 2.001; shift += 0.25) {
    const value = replayScore(casual, irc, { ...DEFAULT_CONSTANTS, topic: fitted.topic, fresh: { ...fitted.fresh, bias: fitted.fresh.bias + shift } }, o.casualShare);
    if (value > bestValue) {
      bestValue = value;
      bestShift = shift;
    }
  }
  log(`new-topic bias shifted by ${bestShift.toFixed(2)} after replay (score ${bestValue.toFixed(2)})`);
  return { ...DEFAULT_CONSTANTS, topic: fitted.topic, fresh: { ...fitted.fresh, bias: Math.round((fitted.fresh.bias + bestShift) * 100) / 100 } };
}

/**
 * Optional hand adjustment after fitting: scale the weights of content evidence
 * (shared words, meaning) and of question-answer ties. On the casual chats the
 * likelihood fit under-weights them relative to "whatever spoke last", because they
 * fire rarely; x1.5 gave the same one-to-one score with better VI, more exactly right
 * lanes and fewer spurious lanes on replay. The shipped casual weights use it.
 */
const BOOSTED = ["lexical", "semPos", "semPosInfo", "semNegInfo", "questionAnswer", "questionShort", "questionLong"] as const;
function boosted(p: LaneParams, factor: number): LaneParams {
  const topic = { ...p.topic };
  for (const name of BOOSTED) topic[name] = Math.round(p.topic[name] * factor * 100) / 100;
  return { ...p, topic };
}

async function main() {
  const objective = arg("objective", "joint") as Objective;
  const priorFile = arg("prior", "");
  let prior = new Float64Array(T + N);
  if (priorFile) {
    const from = JSON.parse(fs.readFileSync(priorFile, "utf8")) as LaneWeights;
    prior = Float64Array.from([...TOPIC_FEATURES.map((n) => (n === "addresseeCrowd" ? 0 : (from.topic[n] ?? 0))), ...NEW_FEATURES.map((n) => (n.startsWith("crowd") ? 0 : (from.fresh[n] ?? 0)))]);
  }
  const o: Options = { l2: Number(arg("l2", "0.01")), newWeight: Number(arg("new-weight", "2")), casualShare: Number(arg("casual-share", "0.6")), steps: Number(arg("steps", "3000")), rounds: Number(arg("rounds", "0")), prior };
  const boost = Number(arg("boost", "1"));
  const casual = objective === "irc" ? [] : await prepareAll(loadCasual("dev"));
  const irc = objective === "casual" ? [] : await prepareAll(loadIrc("dev"));
  console.log(`objective ${objective}, L2 ${o.l2}, topic starts x${o.newWeight}, replay rounds ${o.rounds}${objective === "joint" ? `, casual share ${o.casualShare}` : ""}`);

  if (process.argv.includes("--cv")) {
    // Leave one casual chat out: fit on the rest, replay the one left out. Every chat
    // is scored by a model that never saw it, which is how to compare settings
    // without touching the test half.
    const held = casual.map((chat, i) => {
      const params = boosted(train(casual.filter((_, j) => j !== i), irc, { ...o, steps: Math.min(o.steps, 1500) }), boost);
      return simulate(chat, params);
    });
    console.log(formatScores("Casual dev, leave-one-chat-out", score(held)));
    console.log(`  per chat 1-1: ${held.map((h) => score([h]).oneToOne.toFixed(0)).join(" ")}`);
    return;
  }

  const params = boosted(train(casual, irc, o, console.log), boost);
  if (boost !== 1) console.log(`content and question weights scaled x${boost} after fitting`);
  const weights: LaneWeights = { topic: params.topic, fresh: params.fresh };
  if (casual.length) console.log(formatScores("Casual dev, replayed from scratch", score(casual.map((p) => simulate(p, params)))));
  if (irc.length) console.log(formatScores("IRC dev, replayed from scratch", score(irc.map((p) => simulate(p, params)))));

  fs.mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `${objective}.json`);
  fs.writeFileSync(out, JSON.stringify(weights, null, 2) + "\n");
  console.log(`weights -> ${out}`);
  const show = (rec: Record<string, number>) => Object.entries(rec).map(([k, x]) => `${k} ${x}`).join(", ");
  console.log(`topic: ${show(weights.topic)}\nnew:   ${show(weights.fresh)}`);
}

await main();
