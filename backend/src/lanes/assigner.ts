import { NEW_FEATURES, TOPIC_FEATURES, type LaneConstants, type LaneParams, type NewFeature, type TopicFeature } from "./params.js";
import { infoOf, type TextFeatures } from "./text.js";

/**
 * The lane assigner: given a new message and what has been said recently, decide
 * which existing topic it continues, or that it starts a new one.
 *
 * It is a ranking model. Every recently active topic gets a score, a weighted sum of
 * features describing how well the message fits it; "start a new topic" gets a score
 * too, from features of the message alone. The highest score wins.
 *
 * It is a pure function of its inputs: no database, no model, no clock. The server
 * (lanes/service.ts), the offline evaluation and the weight fitting (eval/) all call
 * the same code, so the numbers in the README describe what runs in production.
 */

/** One earlier message, as the assigner sees it. */
export interface HistoryMessage {
  senderId: string;
  /** Milliseconds since the epoch. */
  at: number;
  topicId: string;
  /**
   * Centred cosine similarity between this message and the new one (about 0 for two
   * unrelated messages of the same chat); null if either has no embedding.
   */
  sim: number | null;
  text: TextFeatures;
  /** People this message was addressed to by name. */
  addressees: string[];
}

export interface NewMessage {
  senderId: string;
  at: number;
  text: TextFeatures;
  addressees: string[];
  hasEmbedding: boolean;
}

export type TopicFeatures = Record<TopicFeature, number>;
export type NewFeatures = Record<NewFeature, number>;

export interface Featurised {
  /** How informative the message was judged to be, 0..1. */
  info: number;
  candidates: { topicId: string; features: TopicFeatures }[];
  fresh: NewFeatures;
}

export interface TopicScore {
  topicId: string;
  score: number;
  features: TopicFeatures;
}

export interface Decision {
  /** The topic to join, or null to start a new one. */
  topicId: string | null;
  /** Best score among existing topics (-Infinity when there were none). */
  score: number;
  /** Score of starting a new topic. */
  newScore: number;
  info: number;
  /** Every candidate, best first. Kept for debugging and for the tests. */
  candidates: TopicScore[];
  fresh: NewFeatures;
}

const MIN = 60_000;
const decay = (ageMs: number, tauMinutes: number) => Math.exp(-Math.max(0, ageMs) / (tauMinutes * MIN));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Describe the message's fit with each recently active topic, and how much it looks
 * like the start of something new.
 *
 * @param history Earlier messages of the conversation that already have a topic,
 *   oldest first. Only a recent window is needed (the server passes the last 200).
 */
export function featurise(msg: NewMessage, history: HistoryMessage[], c: LaneConstants): Featurised {
  const info = infoOf(msg.text, c.infoTokens);
  const low = 1 - info;

  const byTopic = new Map<string, HistoryMessage[]>();
  for (const h of history) {
    const list = byTopic.get(h.topicId);
    if (list) list.push(h);
    else byTopic.set(h.topicId, [h]);
  }

  // Where the author spoke last, anywhere in the conversation.
  let authorLast: HistoryMessage | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.senderId === msg.senderId) {
      authorLast = history[i];
      break;
    }
  }

  // How the author's recent messages are spread over topics. People stick to their
  // own threads, and this does not fade with time, so it still points the right way
  // when someone comes back to a topic an hour later ("GOT THEM").
  const authorIn = new Map<string, number>();
  let authorTotal = 0;
  for (let i = history.length - 1; i >= 0 && authorTotal < 6; i--) {
    const h = history[i]!;
    if (h.senderId !== msg.senderId) continue;
    authorIn.set(h.topicId, (authorIn.get(h.topicId) ?? 0) + 1);
    authorTotal++;
  }

  // How crowded is the room? Six or fewer recent speakers is a group of friends (0);
  // thirty or more is a public channel (1).
  const speakers = new Set<string>();
  for (const h of history) speakers.add(h.senderId);
  const crowd = clamp01((speakers.size - 6) / 24);

  // The author is mid-thought if their own line was the very last thing said, just now.
  const lastMessage = history[history.length - 1];
  const burstTopic = lastMessage && lastMessage.senderId === msg.senderId && msg.at - lastMessage.at <= 90_000 ? lastMessage.topicId : null;

  // "What was just said": the last few messages, nearer ones counting more.
  const adjacency = new Map<string, number>();
  let weight = 1;
  for (let i = history.length - 1, n = 0; i >= 0 && n < c.adjacencyWindow; i--, n++) {
    const h = history[i]!;
    adjacency.set(h.topicId, (adjacency.get(h.topicId) ?? 0) + weight * decay(msg.at - h.at, c.tauFast));
    weight *= c.gammaAdjacency;
  }

  // In how many topics does each of the message's content words appear? A word found
  // in one topic only ("ramen") identifies it; one found everywhere says nothing.
  const wordTopics = new Map<string, Set<string>>();
  if (msg.text.content.length > 0) {
    const wanted = new Set(msg.text.content);
    for (const h of history) {
      for (const w of h.text.content) {
        if (!wanted.has(w)) continue;
        const set = wordTopics.get(w);
        if (set) set.add(h.topicId);
        else wordTopics.set(w, new Set([h.topicId]));
      }
    }
  }

  const candidates: Featurised["candidates"] = [];

  for (const [topicId, all] of byTopic) {
    const recent = all.slice(-c.topicMemory);
    const last = recent[recent.length - 1]!;

    // --- Meaning: how close is this message to what the topic has been about? ---
    // Compared against everything the topic has said in the window, not just its
    // last few lines: a topic is defined by its substantial messages, and those are
    // often followed by a run of "ok" / "8 works" / "lol".
    const sims: number[] = [];
    for (const h of all) {
      if (h.sim === null) continue;
      const above = (h.sim - c.simFloor) / (c.simCeil - c.simFloor);
      // Positive evidence counts in proportion to how informative the matched line was
      // (matching "lol" means nothing). Negative evidence needs no such discount.
      sims.push(above >= 0 ? Math.min(1, above) * (0.25 + 0.75 * infoOf(h.text, c.infoTokens)) : Math.max(-1, (h.sim - c.simFloor) / c.simBelow));
    }
    sims.sort((a, b) => b - a);
    const top = sims.slice(0, 3);
    const sem = top.length === 0 ? 0 : c.simMaxMix * top[0]! + (1 - c.simMaxMix) * (top.reduce((a, b) => a + b, 0) / top.length);

    // Shared distinctive words, each weighted by how few topics use it.
    let shared = 0;
    for (const [, topics] of wordTopics) if (topics.has(topicId)) shared += 1 / topics.size;

    // --- Conversation: who is talking to whom, and when ---
    let authorAt = -Infinity;
    for (const h of recent) if (h.senderId === msg.senderId) authorAt = h.at;

    // The message names someone: is that person part of this topic?
    let addressee = 0;
    for (const who of msg.addressees) {
      for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i]!.senderId === who) {
          addressee = Math.max(addressee, decay(msg.at - recent[i]!.at, c.tauSlow));
          break;
        }
      }
    }

    // Is this topic waiting on the author? Someone here named them, or asked a
    // question right after the author spoke here (an implied "you").
    // And is there a question nobody has answered yet?
    let expected = 0;
    let turn = 0;
    let openQuestion: HistoryMessage | undefined;
    let previousSpeaker: string | undefined;
    for (const h of recent) {
      if (h.senderId === msg.senderId) {
        // The author has spoken here since: whatever was waiting on them is settled.
        expected = 0;
        turn = 0;
        openQuestion = undefined;
      } else {
        // Someone spoke right after the author did: a reply, and now it is the author's turn.
        if (previousSpeaker === msg.senderId) turn = 1;
        const age = msg.at - h.at;
        if (h.addressees.includes(msg.senderId)) expected = Math.max(expected, decay(age, c.tauSlow));
        if (h.text.isQuestion && previousSpeaker === msg.senderId) expected = Math.max(expected, 0.6 * decay(age, c.tauSlow));
        // A reply from anyone but the asker closes the question.
        if (openQuestion && h.senderId !== openQuestion.senderId) openQuestion = undefined;
        if (h.text.isQuestion) openQuestion = h;
      }
      previousSpeaker = h.senderId;
    }
    const question = openQuestion ? decay(msg.at - openQuestion.at, c.tauSlow / 3) : 0;
    const adj = adjacency.get(topicId) ?? 0;
    const recencyFast = decay(msg.at - last.at, c.tauFast);

    candidates.push({
      topicId,
      features: {
        semPosInfo: msg.hasEmbedding ? Math.max(0, sem) * info : 0,
        semNegInfo: msg.hasEmbedding ? Math.min(0, sem) * info : 0,
        semPos: msg.hasEmbedding ? Math.max(0, sem) : 0,
        lexical: 1 - Math.exp(-shared),
        recencyFastLow: recencyFast * low,
        recencyFastHigh: recencyFast * info,
        recencySlow: decay(msg.at - last.at, c.tauSlow),
        adjacencyLow: adj * low,
        adjacencyHigh: adj * info,
        reactionAdjacency: msg.text.isReaction ? adj : 0,
        authorFast: authorAt === -Infinity ? 0 : decay(msg.at - authorAt, c.tauFast),
        authorSlow: authorAt === -Infinity ? 0 : decay(msg.at - authorAt, c.tauSlow),
        authorLast: authorLast?.topicId === topicId ? decay(msg.at - authorLast.at, c.tauSlow) : 0,
        authorShare: authorTotal === 0 ? 0 : (authorIn.get(topicId) ?? 0) / authorTotal,
        turn: turn * decay(msg.at - last.at, c.tauSlow),
        burst: burstTopic === topicId ? 1 : 0,
        addressee,
        addresseeCrowd: addressee * crowd,
        expected,
        questionAnswer: msg.text.isAnswerLike ? question : 0,
        questionShort: !msg.text.isAnswerLike && info < 0.5 ? question : 0,
        questionLong: !msg.text.isAnswerLike && info >= 0.5 ? question : 0,
        typeMatch: openQuestion?.text.asksQuantity && msg.text.hasNumber ? question : 0,
      },
    });
  }

  const newcomer = authorLast ? 1 - decay(msg.at - authorLast.at, c.tauSlow) : 1;
  const fresh: NewFeatures = {
    bias: 1,
    info,
    opener: msg.text.isQuestion && !msg.text.isAnswerLike ? info : 0,
    novelQuestion: msg.text.isQuestion && !msg.text.isAnswerLike && msg.text.content.length > 0 && wordTopics.size === 0 ? 1 : 0,
    cue: msg.text.hasNewTopicCue ? 1 : 0,
    reaction: msg.text.isReaction ? 1 : 0,
    answerLike: msg.text.isAnswerLike ? 1 : 0,
    addressed: msg.addressees.length > 0 ? 1 : 0,
    novelInfo: msg.text.content.length > 0 && wordTopics.size === 0 ? info : 0,
    silence: lastMessage ? 1 - decay(msg.at - lastMessage.at, c.tauSlow) : 1,
    newcomer,
    crowd,
    crowdNewcomer: crowd * newcomer,
  };
  return { info, candidates, fresh };
}

export function assign(msg: NewMessage, history: HistoryMessage[], p: LaneParams): Decision {
  const f = featurise(msg, history, p);
  const candidates: TopicScore[] = f.candidates.map(({ topicId, features }) => {
    let score = 0;
    for (const name of TOPIC_FEATURES) score += p.topic[name] * features[name];
    return { topicId, score, features };
  });
  candidates.sort((a, b) => b.score - a.score);
  let newScore = 0;
  for (const name of NEW_FEATURES) newScore += p.fresh[name] * f.fresh[name];
  const best = candidates[0];
  return {
    topicId: best && best.score > newScore ? best.topicId : null,
    score: best?.score ?? -Infinity,
    newScore,
    info: f.info,
    candidates,
    fresh: f.fresh,
  };
}
