import { describe, expect, it } from "vitest";
import { assign, featurise, type HistoryMessage, type NewMessage } from "../src/lanes/assigner.js";
import { DEFAULT_CONSTANTS, DEFAULT_PARAMS } from "../src/lanes/params.js";
import { addresseesOf, analyseText } from "../src/lanes/text.js";

const PEOPLE = ["asha", "ben", "chidi", "dev"].map((id) => ({ id, names: [id] }));

/** A line of earlier conversation: [seconds, speaker, topic, text, similarity to the new message]. */
type Line = [number, string, string, string, number?];

const history = (lines: Line[]): HistoryMessage[] =>
  lines.map(([sec, senderId, topicId, text, sim]) => ({
    senderId,
    at: sec * 1000,
    topicId,
    sim: sim ?? 0,
    text: analyseText(text),
    addressees: addresseesOf(text, senderId, PEOPLE),
  }));

const message = (sec: number, senderId: string, text: string, hasEmbedding = true): NewMessage => ({
  senderId,
  at: sec * 1000,
  text: analyseText(text),
  addressees: addresseesOf(text, senderId, PEOPLE),
  hasEmbedding,
});

const decide = (lines: Line[], sec: number, who: string, text: string) => assign(message(sec, who, text), history(lines), DEFAULT_PARAMS);
const features = (lines: Line[], sec: number, who: string, text: string, topicId: string) =>
  featurise(message(sec, who, text), history(lines), DEFAULT_CONSTANTS).candidates.find((c) => c.topicId === topicId)!.features;

// Two conversations going at once: dinner (asha, ben) and an assignment (chidi, dev).
const INTERLEAVED: Line[] = [
  [0, "asha", "dinner", "who's in for dinner on saturday?"],
  [14, "ben", "dinner", "me! where though"],
  [23, "chidi", "hw", "did anyone start the networks assignment"],
  [44, "asha", "dinner", "thinking that ramen place near the station"],
  [50, "dev", "hw", "not yet, isn't it due friday?"],
];

describe("the assigner's decisions", () => {
  it("starts a topic when nothing has been said", () => {
    const d = decide([], 0, "asha", "who's in for dinner on saturday?");
    expect(d.topicId).toBeNull();
    expect(d.candidates).toEqual([]);
  });

  it("puts a reaction with the message it follows, with no similarity at all", () => {
    for (const text of ["lol", "hahaha", "😂", "nice", "ok"]) {
      expect(decide(INTERLEAVED, 54, "ben", text).topicId, text).toBe("hw");
    }
    expect(decide(INTERLEAVED.slice(0, 4), 48, "ben", "lol").topicId).toBe("dinner");
  });

  it("keeps a reaction in the author's own exchange when another conversation has cut in", () => {
    // Dev asked about the deadline; Chidi answered; dinner talk cut in; Dev reacts.
    const more: Line[] = [...INTERLEAVED, [58, "chidi", "hw", "thursday midnight actually"], [63, "asha", "dinner", "yeah but it moves fast"]];
    expect(decide(more, 76, "dev", "wait what").topicId).toBe("hw");
  });

  it("sends a short answer to the topic whose question it answers", () => {
    const lines: Line[] = [...INTERLEAVED, [59, "ben", "dinner", "what time"], [70, "chidi", "hw", "thursday midnight actually"], [81, "asha", "dinner", "8?"]];
    expect(decide(lines, 87, "ben", "8 works").topicId).toBe("dinner");
  });

  it("starts a topic for a substantial message about something new, once the chat has gone quiet", () => {
    const d = decide(INTERLEAVED, 50 + 15 * 60, "chidi", "btw is the wifi down for anyone else");
    expect(d.topicId).toBeNull();
    expect(d.fresh.novelQuestion).toBe(1);
    expect(d.fresh.cue).toBe(1);
  });

  it("lets a substantial, clearly related message rejoin an older topic over a more recent one", () => {
    const lines: Line[] = [
      [0, "asha", "dinner", "thinking that ramen place near the station", 0.7],
      [20, "ben", "dinner", "the one with the long queue?", 0.3],
      [900, "chidi", "hw", "did anyone start the networks assignment", -0.1],
      [915, "dev", "hw", "not yet", -0.05],
    ];
    expect(decide(lines, 940, "ben", "should we split the ramen bill on the app afterwards").topicId).toBe("dinner");
  });

  it("still decides without an embedding, from the conversation alone", () => {
    const d = assign(message(54, "ben", "lol", false), history(INTERLEAVED).map((h) => ({ ...h, sim: null })), DEFAULT_PARAMS);
    expect(d.topicId).toBe("hw");
    expect(d.candidates.every((c) => c.features.semPos === 0 && c.features.semPosInfo === 0 && c.features.semNegInfo === 0)).toBe(true);
  });

  it("is a pure function: same answer every time, inputs untouched", () => {
    const h = history(INTERLEAVED);
    const m = message(56, "ben", "what time");
    const snapshot = JSON.stringify([h, m]);
    const first = assign(m, h, DEFAULT_PARAMS);
    expect(assign(m, h, DEFAULT_PARAMS)).toEqual(first);
    expect(JSON.stringify([h, m])).toBe(snapshot);
  });

  it("ranks every recently active topic and reports its reasons", () => {
    const d = decide(INTERLEAVED, 56, "ben", "what time");
    expect(d.candidates.map((c) => c.topicId).sort()).toEqual(["dinner", "hw"]);
    expect(d.candidates[0]!.score).toBeGreaterThanOrEqual(d.candidates[1]!.score);
    expect(d.info).toBe(0);
  });
});

/**
 * Things the shipped weights get wrong, written down as tests. `it.fails` passes while
 * the behaviour is still wrong; if a change to the model fixes one, the test turns red
 * and should be moved up into the suite above.
 */
describe("known limitations", () => {
  it.fails("a change of subject in the middle of a fast exchange is put in the lane that was just active", () => {
    // Nine seconds after the last message, with no pause to signal a break, and right
    // after an unanswered question in the other lane.
    expect(decide(INTERLEAVED, 59, "ben", "btw is the wifi down for anyone else").topicId).toBeNull();
  });

  it.fails("a short follow-up goes to the lane that spoke last, even when it is the author's turn elsewhere", () => {
    // Ben asked where; Asha answered; one assignment message cut in; Ben follows up on dinner.
    expect(decide(INTERLEAVED, 56, "ben", "what time").topicId).toBe("dinner");
  });
});

describe("the signals behind a decision", () => {
  it("turn: the last thing said in the topic was a reply to the author", () => {
    expect(features(INTERLEAVED, 56, "ben", "what time", "dinner").turn).toBeGreaterThan(0.9);
    expect(features(INTERLEAVED, 56, "ben", "what time", "hw").turn).toBe(0);
    // Once the author has answered, it is no longer their turn.
    const after: Line[] = [...INTERLEAVED, [56, "ben", "dinner", "what time"]];
    expect(features(after, 60, "ben", "or should we go sunday", "dinner").turn).toBe(0);
  });

  it("burst: the author's own line was the very last thing said, moments ago", () => {
    const lines: Line[] = [...INTERLEAVED, [56, "dev", "hw", "wait what"]];
    expect(features(lines, 60, "dev", "i thought friday", "hw").burst).toBe(1);
    expect(features(lines, 60, "dev", "i thought friday", "dinner").burst).toBe(0);
    expect(features(lines, 60, "ben", "same", "hw").burst).toBe(0);
    expect(features(lines, 56 + 600, "dev", "i thought friday", "hw").burst).toBe(0);
  });

  it("expected: someone in the topic named the author", () => {
    const lines: Line[] = [...INTERLEAVED, [60, "asha", "dinner", "chidi dev you coming?"]];
    expect(features(lines, 70, "chidi", "yep count me in", "dinner").expected).toBeGreaterThan(0.9);
    expect(features(lines, 70, "ben", "yep count me in", "dinner").expected).toBe(0);
  });

  it("expected: weaker, but present, when someone asks a question right after the author spoke", () => {
    // In hw, Dev's question came straight after Chidi's line: an implied "you".
    const implied = features(INTERLEAVED, 70, "chidi", "thursday", "hw").expected;
    expect(implied).toBeGreaterThan(0.5);
    expect(implied).toBeLessThan(0.7);
    expect(features(INTERLEAVED, 70, "asha", "thursday", "hw").expected).toBe(0);
  });

  it("question: open until someone other than the asker replies", () => {
    const asked: Line[] = [[0, "chidi", "hw", "did anyone start the networks assignment"]];
    expect(features(asked, 10, "dev", "not yet", "hw").questionAnswer).toBeGreaterThan(0.9);
    const answered: Line[] = [...asked, [8, "ben", "hw", "i did the first two"]];
    expect(features(answered, 12, "dev", "not yet", "hw").questionAnswer).toBe(0);
    // The asker adding to their own question keeps it open.
    const extended: Line[] = [...asked, [5, "chidi", "hw", "it looks long"]];
    expect(features(extended, 12, "dev", "not yet", "hw").questionAnswer).toBeGreaterThan(0.9);
  });

  it("typeMatch: a number answers a question about time or quantity", () => {
    const lines: Line[] = [[0, "ben", "dinner", "what time should we meet?"]];
    expect(features(lines, 8, "asha", "8", "dinner").typeMatch).toBeGreaterThan(0.9);
    expect(features(lines, 8, "asha", "sounds good", "dinner").typeMatch).toBe(0);
  });

  it("authorShare: where the author's recent messages have been", () => {
    expect(features(INTERLEAVED, 60, "asha", "anyone else", "dinner").authorShare).toBe(1);
    expect(features(INTERLEAVED, 60, "asha", "anyone else", "hw").authorShare).toBe(0);
    expect(features(INTERLEAVED, 60, "nobody", "hello", "hw").authorShare).toBe(0);
  });

  it("lexical: sharing a word that only one topic uses", () => {
    const lines: Line[] = [...INTERLEAVED, [55, "chidi", "hw", "question 3 of the assignment is brutal"]];
    const hw = features(lines, 700, "dev", "finally finished the assignment", "hw");
    const dinner = features(lines, 700, "dev", "finally finished the assignment", "dinner");
    expect(hw.lexical).toBeGreaterThan(0.6);
    expect(dinner.lexical).toBe(0);
  });

  it("meaning: similarity counts for more against informative lines, and dissimilarity counts against", () => {
    const similarToSubstance: Line[] = [[0, "asha", "t", "thinking that ramen place near the station", 0.5]];
    const similarToFiller: Line[] = [[0, "asha", "t", "ok", 0.5]];
    const text = "which ramen place has the shortest queue on weekends";
    expect(features(similarToSubstance, 30, "ben", text, "t").semPos).toBeGreaterThan(features(similarToFiller, 30, "ben", text, "t").semPos * 2);
    const unrelated: Line[] = [[0, "asha", "t", "thinking that ramen place near the station", -0.3]];
    expect(features(unrelated, 30, "ben", text, "t").semNegInfo).toBeLessThan(-0.5);
    expect(features(unrelated, 30, "ben", "ok", "t").semNegInfo).toBeCloseTo(0); // an empty message has no meaning to mismatch
  });

  it("crowd: zero in a small group, high in a busy channel", () => {
    const small = featurise(message(60, "ben", "hello"), history(INTERLEAVED), DEFAULT_CONSTANTS);
    expect(small.fresh.crowd).toBe(0);
    const busy: Line[] = Array.from({ length: 40 }, (_, i) => [i, `user${i}`, `t${i % 5}`, "some message about linux"]);
    expect(featurise(message(60, "ben", "hello"), history(busy), DEFAULT_CONSTANTS).fresh.crowd).toBe(1);
  });
});
