/**
 * The lane assigner's numbers.
 *
 * `LaneConstants` shape the features (time scales, how similarity is mapped). They
 * are set by hand. `LaneWeights` say how much each feature counts; they are fitted
 * to labelled conversations by eval/fit.ts and pasted in below. See the README,
 * "How lane assignment works".
 */
export interface LaneConstants {
  /** Content words at which a message counts as fully informative. */
  infoTokens: number;
  /**
   * Centred cosine similarity (embedding/centre.ts) at which a topic message is
   * neutral evidence (simFloor) and at which it is as strong as it gets (simCeil).
   * Below the floor it counts against the topic, reaching -1 at simFloor - simBelow.
   */
  simFloor: number;
  simCeil: number;
  simBelow: number;
  /** Blend of the best-matching topic message (1) and the mean of the top three (0). */
  simMaxMix: number;
  /** Two time scales, in minutes: "just now" and "earlier in this session". */
  tauFast: number;
  tauSlow: number;
  /** How quickly "what was just said" fades per intervening message. */
  gammaAdjacency: number;
  /** Recent messages remembered per topic for conversational signals. */
  topicMemory: number;
  /** How many of the latest messages count as "just said". */
  adjacencyWindow: number;
}

/** What makes an existing topic a good home for the message. */
export const TOPIC_FEATURES = [
  "semPosInfo", // similar in meaning, weighted by how informative the message is
  "semNegInfo", // clearly about something else (negative), weighted the same way
  "semPos", // similar in meaning, regardless of length
  "lexical", // shares distinctive words ("Q3", "villa", "nvidia")
  "recencyFastLow", // topic active just now; message is short
  "recencyFastHigh", // topic active just now; message is informative
  "recencySlow", // topic active earlier in this session
  "adjacencyLow", // topic of the last few messages; message is short
  "adjacencyHigh", // topic of the last few messages; message is informative
  "reactionAdjacency", // a pure reaction ("lol") right after this topic spoke
  "authorFast", // the author spoke in this topic just now
  "authorSlow", // the author spoke in this topic earlier
  "authorLast", // this is where the author last spoke, anywhere
  "authorShare", // share of the author's recent messages that are in this topic
  "turn", // the last thing said here was a reply to the author: it is their turn
  "burst", // the author's own previous line was the last thing said, here
  "addressee", // the message names someone who is taking part here
  "addresseeCrowd", // the same, in a crowded channel
  "expected", // someone here named the author, or asked right after the author spoke
  "questionAnswer", // an open question here; the message opens like an answer
  "questionShort", // an open question here; the message is short
  "questionLong", // an open question here; the message is longer
  "typeMatch", // the open question asks when/how many and the message has a number
] as const;
export type TopicFeature = (typeof TOPIC_FEATURES)[number];

/** What makes the message look like the start of something new. */
export const NEW_FEATURES = [
  "bias",
  "info", // informative messages start topics; "ok" does not
  "opener", // an informative question that is not itself an answer
  "novelQuestion", // a question whose content words have not come up at all
  "cue", // opens with "btw", "also", "quick question", ...
  "reaction", // laughter or an emoji never starts a topic
  "answerLike", // opens like an answer
  "addressed", // names someone: it is part of an exchange
  "novelInfo", // informative, and shares no distinctive word with anything recent
  "silence", // nothing has been said for a while
  "newcomer", // the author has not spoken for a while (or ever)
  "crowd", // dozens of people talking: most new voices start a conversation
  "crowdNewcomer",
] as const;
export type NewFeature = (typeof NEW_FEATURES)[number];

export interface LaneWeights {
  topic: Record<TopicFeature, number>;
  fresh: Record<NewFeature, number>;
}

export interface LaneParams extends LaneConstants, LaneWeights {}

export const DEFAULT_CONSTANTS: LaneConstants = {
  infoTokens: 4,
  simFloor: 0.05,
  simCeil: 0.45,
  simBelow: 0.3,
  simMaxMix: 0.6,
  tauFast: 2,
  tauSlow: 30,
  gammaAdjacency: 0.5,
  topicMemory: 8,
  adjacencyWindow: 6,
};

/**
 * Fitted on the hand-labelled casual group chats (eval/casual/dev-*.txt) with
 * `npm run eval:fit -- --objective casual --boost 1.5`; a copy is in
 * eval/weights/casual.json. SynChat's groups are small, so these ship. Weights fitted
 * on the Ubuntu IRC corpus instead are in eval/weights/irc.json: a crowded public
 * channel behaves differently (see the README for both sets of results).
 */
export const DEFAULT_WEIGHTS: LaneWeights = {
  topic: {
    semPosInfo: 0.92, semNegInfo: 0.32, semPos: 1.53, lexical: 1.85,
    recencyFastLow: 1.78, recencyFastHigh: 0.46, recencySlow: 0.5, adjacencyLow: 1.55,
    adjacencyHigh: 0.16, reactionAdjacency: 0.39, authorFast: 0.58, authorSlow: 0.11,
    authorLast: -0.35, authorShare: 0.27, turn: 0.51, burst: 0.26,
    addressee: 0.11, addresseeCrowd: 0, expected: 0.44, questionAnswer: 1.31,
    questionShort: 0.38, questionLong: 1.02, typeMatch: 0.17,
  },
  fresh: {
    bias: 1.06, info: 0.5, opener: 0.81, novelQuestion: 0.63,
    cue: 0.65, reaction: -0.12, answerLike: -0.38, addressed: -0.31,
    novelInfo: 0.71, silence: -0.05, newcomer: 0.43, crowd: 0,
    crowdNewcomer: 0,
  },
};

export const DEFAULT_PARAMS: LaneParams = { ...DEFAULT_CONSTANTS, ...DEFAULT_WEIGHTS };
