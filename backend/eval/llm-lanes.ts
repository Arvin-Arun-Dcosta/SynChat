/**
 * How accurate are the lanes when an LLM tidies up after the local assigner?
 *
 *   npm run eval:llm                     held-out chats, the configured provider and model
 *   npm run eval:llm -- --split dev      tuning chats (used while writing the prompt)
 *   npm run eval:llm -- --model <id>     another model of the same provider
 *
 * Replays each hand-labelled casual chat the way the app runs: the local assigner
 * places every message at once; whenever the chat goes quiet (the same 90-second
 * rule the server uses) the LLM re-sorts the recent messages. The lanes left at the
 * end are scored. "One tidy-up at the end" is the same thing with a single run after
 * the last message, as when an admin turns AI on for a chat that already exists. Needs GEMINI_API_KEY or ANTHROPIC_API_KEY in .env; costs a few cents.
 *
 * Answers are cached in eval/.cache, so a second run is free and gives the same numbers.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { ClaudeLlm, GeminiLlm, type StructuredLlm, type StructuredRequest } from "../src/digest/llm.js";
import { PromptedDigestModel } from "../src/digest/model.js";
import { planTidy, TIDY_WINDOW, tidyRequest, type TidyRow } from "../src/digest/tidy.js";
import { assign, type HistoryMessage } from "../src/lanes/assigner.js";
import { DEFAULT_PARAMS } from "../src/lanes/params.js";
import { titleFromText } from "../src/lanes/title.js";
import { EVAL_DIR, loadCasual, type Stream } from "./datasets.js";
import { formatScores, score } from "./metrics.js";
import { prepareAll } from "./run.js";
import { HISTORY, type Prepared } from "./simulate.js";

const QUIET_MS = 90_000;
const SHOW_GUESSES = process.argv.includes("--show-guesses");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

/** Wraps a provider with an on-disk cache and patient retries (free-tier keys are rate-limited). */
class CachedLlm implements StructuredLlm {
  calls = 0;
  constructor(private readonly inner: StructuredLlm) {}
  get provider() {
    return this.inner.provider;
  }
  get providerLabel() {
    return this.inner.providerLabel;
  }
  get model() {
    return this.inner.model;
  }
  async generate<T>(req: StructuredRequest<T>): Promise<T> {
    const key = createHash("sha256").update(`${this.inner.model}\n${req.system}\n${req.user}`).digest("hex").slice(0, 32);
    const file = path.join(EVAL_DIR, ".cache", "llm", `${key}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await this.inner.generate(req);
        this.calls++;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(out));
        return out;
      } catch (err) {
        if (attempt >= 5) throw err;
        const wait = 5000 * 2 ** attempt;
        console.error(`  (${(err as Error).message}; retrying in ${wait / 1000}s)`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}

const name = (u: string) => u.charAt(0).toUpperCase() + u.slice(1);

/**
 * One tidy-up over messages [from, to], through the same request and plan code the
 * server uses. Messages up to `sortedThrough` have been tidied before and show their lane.
 */
async function tidy(model: PromptedDigestModel, stream: Stream, topicOf: string[], titles: Map<string, string>, from: number, to: number, sortedThrough: number, fresh: () => string): Promise<number> {
  const people = stream.people.map((p, i) => ({ ref: `P${i + 1}`, name: name(p.id) }));
  const personRef = new Map(stream.people.map((p, i) => [p.id, `P${i + 1}`]));
  const rows: TidyRow[] = stream.messages.slice(from, to + 1).map((m, k) => ({
    id: String(from + k),
    topicId: topicOf[from + k]!,
    author: personRef.get(m.senderId)!,
    text: m.text,
    at: m.at,
    locked: false,
    parentId: null,
    sorted: from + k <= sortedThrough,
  }));
  // Established lanes: every lane holding a message that has been tidied before, latest first.
  const established: string[] = [];
  for (let i = sortedThrough; i >= 0; i--) if (!established.includes(topicOf[i]!)) established.push(topicOf[i]!);
  const request = tidyRequest(rows, people, established.map((id) => ({ id, title: titles.get(id) ?? "New topic" })));
  const plan = planTidy(rows, request.laneRef, await model.tidy(request.input));
  for (const [topicId, title] of plan.retitle) titles.set(topicId, title);
  const created = new Map<string, string>();
  for (const [key, title] of plan.create) {
    created.set(key, fresh());
    titles.set(created.get(key)!, title);
  }
  for (const [id, key] of plan.moves) topicOf[Number(id)] = created.get(key) ?? key;
  return plan.moves.size;
}

async function pipeline(model: PromptedDigestModel, stream: Stream, p: Prepared, withTidy: boolean) {
  const topicOf: string[] = [];
  const titles = new Map<string, string>();
  let next = 0;
  let moved = 0;
  let calls = 0;
  let sortedThrough = -1;
  const fresh = () => `t${next++}`;
  for (let i = 0; i < p.n; i++) {
    const w = p.window[i]!;
    const history: HistoryMessage[] = [...w].map((j, k) => {
      const s = p.sims[i * HISTORY + k]!;
      return { senderId: p.senderId[j]!, at: p.at[j]!, topicId: topicOf[j]!, sim: Number.isNaN(s) ? null : s, text: p.text[j]!, addressees: p.addressees[j]! };
    });
    const d = assign({ senderId: p.senderId[i]!, at: p.at[i]!, text: p.text[i]!, addressees: p.addressees[i]!, hasEmbedding: p.hasEmbedding[i]! }, history, DEFAULT_PARAMS);
    if (d.topicId) topicOf[i] = d.topicId;
    else {
      topicOf[i] = fresh();
      titles.set(topicOf[i]!, titleFromText(stream.messages[i]!.text) ?? "New topic");
    }
    const quiet = i === p.n - 1 || p.at[i + 1]! - p.at[i]! >= QUIET_MS;
    if (withTidy && quiet) {
      // --show-guesses: the earlier design, where the model corrects the local guess instead of sorting afresh.
      moved += await tidy(model, stream, topicOf, titles, Math.max(0, i - TIDY_WINDOW + 1), i, SHOW_GUESSES ? i : sortedThrough, fresh);
      sortedThrough = i;
      calls++;
    }
  }
  return { clustering: { file: p.file, gold: p.gold as string[], pred: [...topicOf] }, moved, calls };
}

/** One tidy-up at the very end: what a group gets the first time its admin turns AI on. */
async function whole(model: PromptedDigestModel, stream: Stream, p: Prepared) {
  const local = (await pipeline(model, stream, p, false)).clustering.pred;
  const titles = new Map<string, string>();
  let next = 0;
  await tidy(model, stream, local, titles, Math.max(0, p.n - TIDY_WINDOW), p.n - 1, -1, () => `w${next++}`);
  return { file: p.file, gold: p.gold as string[], pred: local };
}

const config = loadConfig();
const split = arg("split", "test") as "dev" | "test";
const provider = config.gemini ? "google" : config.llm ? "anthropic" : null;
if (!provider) throw new Error("Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env to run this evaluation.");
const modelId = arg("model", provider === "google" ? config.gemini!.model : config.llm!.model);
const llm = new CachedLlm(provider === "google" ? new GeminiLlm(config.gemini!.apiKey, modelId) : new ClaudeLlm(config.llm!.apiKey, modelId));
const model = new PromptedDigestModel(llm);

const streams = loadCasual(split);
const prepared = await prepareAll(streams);
console.log(`Casual chats, ${split === "test" ? "held out" : "tuning half"}: ${streams.length} chats, ${prepared.reduce((n, p) => n + p.n, 0)} messages. Model: ${modelId}`);

const local = [];
const tidied = [];
const alone = [];
let moved = 0;
let calls = 0;
for (let c = 0; c < streams.length; c++) {
  local.push((await pipeline(model, streams[c]!, prepared[c]!, false)).clustering);
  const t = await pipeline(model, streams[c]!, prepared[c]!, true);
  tidied.push(t.clustering);
  moved += t.moved;
  calls += t.calls;
  if (!process.argv.includes("--no-alone")) alone.push(await whole(model, streams[c]!, prepared[c]!));
  console.error(`  ${streams[c]!.file}: local ${score([local[c]!]).oneToOne.toFixed(0)}%, with tidy-up ${score([tidied[c]!]).oneToOne.toFixed(0)}%${alone[c] ? `, one tidy-up at the end ${score([alone[c]!]).oneToOne.toFixed(0)}%` : ""}`);
}
console.log(formatScores("Local assigner only", score(local)));
console.log(formatScores("Local assigner + LLM tidy-up", score(tidied)));
if (alone.length) console.log(formatScores("One tidy-up at the end of the chat", score(alone)));
console.log(`Tidy-up: ${calls} runs (one per quiet spell), ${moved} messages moved in total; ${llm.calls} new API calls this run.`);
