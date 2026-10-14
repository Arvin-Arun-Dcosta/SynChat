import { describe, expect, it } from "vitest";
import { maxAssignment, score } from "../eval/metrics.js";
import { InProcessQueue } from "../src/jobs/queue.js";
import { addresseesOf, analyseText, infoOf } from "../src/lanes/text.js";
import { titleFromText } from "../src/lanes/title.js";
import { sleep } from "./helpers.js";

describe("reading a message", () => {
  const info = (text: string) => infoOf(analyseText(text), 4);

  it("gives no topical weight to acknowledgements, however they are spelled", () => {
    for (const text of ["ok", "okkk", "yes", "yesss", "nooo", "ohh", "hmm", "k", "sure", "haan", "theek hai", "👍", "😂😂", "lol", "hahaha", "lmaooo", "nice"]) {
      expect(info(text), text).toBe(0);
    }
  });

  it("gives little weight to short replies and full weight to substantial messages", () => {
    expect(info("8 works")).toBeLessThanOrEqual(0.25);
    expect(info("what time")).toBeLessThanOrEqual(0.25);
    expect(info("i thought friday")).toBeLessThanOrEqual(0.25); // day names say when, not what about
    expect(info("thinking that ramen place near the station")).toBeGreaterThanOrEqual(0.75);
    expect(info("goa ke liye flights book kar li hain subah 6 baje ki")).toBe(1);
  });

  it("recognises reactions, questions and answer-like openings", () => {
    expect(analyseText("lol").isReaction).toBe(true);
    expect(analyseText("hahaha true").isReaction).toBe(true);
    expect(analyseText("😂").isReaction).toBe(true);
    expect(analyseText("the router is broken lol").isReaction).toBe(false);

    expect(analyseText("what time").isQuestion).toBe(true);
    expect(analyseText("pool hai?").isQuestion).toBe(true);
    expect(analyseText("did anyone start the assignment").isQuestion).toBe(true);
    expect(analyseText("ok let's do it").isQuestion).toBe(false);
    // No question mark, question word not first, or not English:
    for (const text of ["me! where though", "ok 14th. which hall", "btw is the wifi down for anyone else", "jaipur kaise ja rahe hain", "train ya car", "flights or train"]) {
      expect(analyseText(text).isQuestion, text).toBe(true);
    }
    for (const text of ["no idea what he means", "booked a table for 3 at 8", "sounds good"]) expect(analyseText(text).isQuestion, text).toBe(false);

    for (const text of ["8 works", "yes", "nope, check the portal", "not yet", "haan", "7:15", "me! where though"]) {
      expect(analyseText(text).isAnswerLike, text).toBe(true);
    }
    expect(analyseText("the wifi is down again").isAnswerLike).toBe(false);
  });

  it("spots a bare number that can answer a question about time or quantity", () => {
    expect(analyseText("what time is the show").asksQuantity).toBe(true);
    expect(analyseText("electricity kitna aaya").asksQuantity).toBe(true); // Hindi puts the question word mid-sentence
    expect(analyseText("kitne baje nikalna hai?").asksQuantity).toBe(true);
    expect(analyseText("where is it").asksQuantity).toBe(false);
    expect(analyseText("8 works").hasNumber).toBe(true);
    expect(analyseText("7:15 or 10:30").hasNumber).toBe(true);
    expect(analyseText("sounds good").hasNumber).toBe(false);
  });

  it("notices phrases that change the subject", () => {
    for (const text of ["btw are we still doing the trip", "also what about a used 3070", "quick question about rent", "waise kal ka kya plan hai"]) {
      expect(analyseText(text).hasNewTopicCue, text).toBe(true);
    }
    expect(analyseText("the trip is also in december").hasNewTopicCue).toBe(false);
  });

  it("extracts distinctive words, stemmed, without filler", () => {
    expect(analyseText("Booked 4 flight tickets, 6:10 am on the 23rd").content.sort()).toEqual(["23rd", "booked", "flight", "ticket"]);
    expect(analyseText("is Q3 the one with the sliding window proof").content).toContain("q3");
    expect(analyseText("should i buy the 4060").content).toContain("4060");
    expect(analyseText("ok yes thanks").content).toEqual([]);
  });

  it("copes with empty and unusual input", () => {
    for (const text of ["", "   ", null, undefined, "https://example.com/a?b=c", "!!!", "ａｂｃ", "x".repeat(5000)]) {
      expect(() => analyseText(text)).not.toThrow();
    }
    expect(analyseText(null).contentCount).toBe(0);
  });
});

describe("who a message is addressed to", () => {
  const people = [
    { id: "a", names: ["asha", "asha_r"] },
    { id: "b", names: ["ben"] },
    { id: "c", names: ["chidi"] },
    { id: "d", names: ["al"] }, // too short to match safely
  ];

  it("finds people named by mention, by prefix or in passing", () => {
    expect(addresseesOf("@ben are you coming", "a", people)).toEqual(["b"]);
    expect(addresseesOf("Ben: try restarting it", "a", people)).toEqual(["b"]);
    expect(addresseesOf("chidi, dev you coming?", "a", people)).toEqual(["c"]);
    expect(addresseesOf("thanks asha_r and ben!", "c", people)).toEqual(["a", "b"]);
  });

  it("does not match parts of words, the sender, or very short names", () => {
    expect(addresseesOf("the benefit of the doubt", "a", people)).toEqual([]);
    expect(addresseesOf("ben here, back online", "b", people)).toEqual([]);
    expect(addresseesOf("al dente pasta", "a", people)).toEqual([]);
    expect(addresseesOf("", "a", people)).toEqual([]);
  });
});

describe("topic titles without a model", () => {
  it("uses the opening message, minus greetings, mentions and links", () => {
    expect(titleFromText("who's in for dinner on saturday?")).toBe("Who's in for dinner on saturday?");
    expect(titleFromText("hey guys, did anyone start the networks assignment")).toBe("Did anyone start the networks assignment");
    expect(titleFromText("btw @ben are we still doing the hampi trip")).toBe("Are we still doing the hampi trip");
    expect(titleFromText("look at this https://example.com/very/long/link it is wild")).toBe("Look at this it is wild");
  });

  it("keeps only the first sentence and cuts long ones at a word boundary", () => {
    expect(titleFromText("Rent is due on the 5th. Please send me your share by then.")).toBe("Rent is due on the 5th");
    const long = titleFromText("the landlord says the plumber will come on thursday morning between nine and eleven so someone must be home");
    expect(long!.length).toBeLessThanOrEqual(49);
    expect(long).toMatch(/…$/);
    expect(long).not.toMatch(/\s…$/);
  });

  it("returns nothing when the message does not say what it is about", () => {
    for (const text of ["hey guys", "hi", "ok", "😂", "", "https://example.com", null]) expect(titleFromText(text), String(text)).toBeNull();
  });
});

describe("the keyed queue", () => {
  it("runs jobs with the same key one at a time, in order", async () => {
    const queue = new InProcessQueue();
    const log: string[] = [];
    for (const [name, ms] of [["a", 30], ["b", 5], ["c", 1]] as const) {
      queue.enqueue("conv-1", async () => {
        log.push(`start ${name}`);
        await sleep(ms);
        log.push(`end ${name}`);
      });
    }
    await queue.idle();
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("runs different keys side by side", async () => {
    const queue = new InProcessQueue();
    const log: string[] = [];
    queue.enqueue("slow", async () => {
      await sleep(40);
      log.push("slow");
    });
    queue.enqueue("fast", async () => {
      log.push("fast");
    });
    await queue.idle();
    expect(log).toEqual(["fast", "slow"]);
  });

  it("keeps going after a job fails", async () => {
    const errors: unknown[] = [];
    const queue = new InProcessQueue((_key, err) => errors.push(err));
    const log: string[] = [];
    queue.enqueue("k", async () => {
      throw new Error("boom");
    });
    queue.enqueue("k", async () => {
      log.push("after");
    });
    await queue.idle();
    expect(log).toEqual(["after"]);
    expect(errors).toHaveLength(1);
  });
});

describe("evaluation metrics", () => {
  it("scores a perfect clustering as 100 on everything", () => {
    const s = score([{ file: "f", gold: ["a", "a", "b", "b", "c"], pred: ["x", "x", "y", "y", "z"] }]);
    expect(s).toMatchObject({ vi: 100, oneToOne: 100, precision: 100, recall: 100, f1: 100, ari: 100 });
  });

  it("matches hand-computed values on a small example", () => {
    // gold {0,1,2} {3,4,5}; predicted {0,1} {2,3} {4,5}
    const s = score([{ file: "f", gold: ["a", "a", "a", "b", "b", "b"], pred: ["x", "x", "y", "y", "z", "z"] }]);
    // Best one-to-one matching pairs a-x (2) and b-z (2): 4 of 6.
    expect(s.oneToOne).toBeCloseTo((100 * 4) / 6, 6);
    // H(pred|gold) = 0.9183 bits, H(gold|pred) = 1/3 bit; VI = 1.2516; scaled by log2(6).
    expect(s.vi).toBeCloseTo(100 - (100 * (0.9182958 + 1 / 3)) / Math.log2(6), 4);
    expect(s).toMatchObject({ precision: 0, recall: 0, f1: 0, goldClusters: 2, predClusters: 3 });
  });

  it("counts exact-match clusters, ignoring clusters of one message, pooled over files", () => {
    const s = score([
      { file: "one", gold: ["a", "a", "b", "b", "c"], pred: ["x", "x", "y", "z", "w"] },
      { file: "two", gold: ["a", "a", "a"], pred: ["q", "q", "q"] },
    ]);
    // Gold clusters with 2+ messages: 3. Predicted with 2+: 2. Exactly right: 2.
    expect(s.precision).toBeCloseTo(100, 6);
    expect(s.recall).toBeCloseTo((100 * 2) / 3, 6);
    expect(s.f1).toBeCloseTo(80, 6);
  });

  it("never matches a cluster in one file to a cluster in another", () => {
    const s = score([
      { file: "one", gold: ["a", "a"], pred: ["same", "same"] },
      { file: "two", gold: ["a", "a"], pred: ["same", "other"] },
    ]);
    expect(s.oneToOne).toBeCloseTo(75, 6);
    expect(s.goldClusters).toBe(2);
  });

  it("finds the best assignment, checked against brute force", () => {
    const permutations = (n: number): number[][] => (n === 0 ? [[]] : permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)])));
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 60; trial++) {
      const rows = 1 + Math.floor(rand() * 5);
      const cols = 1 + Math.floor(rand() * 5);
      const w = Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.floor(rand() * 9)));
      const n = Math.max(rows, cols);
      const best = Math.max(...permutations(n).map((perm) => perm.reduce((sum, col, row) => sum + (w[row]?.[col] ?? 0), 0)));
      expect(maxAssignment(w), JSON.stringify(w)).toBe(best);
    }
    expect(maxAssignment([])).toBe(0);
  });
});
