import type { DigestInput, DigestModel, DigestOutput, TidyInput, TidyOutput } from "./model.js";

/**
 * NOT AI. A crude rule-based stand-in for the digest model, so the catch-up, status
 * and inbox screens can be developed and walked through without an API key.
 * Enabled only with LLM_STUB=true, and never in production. Its output is clearly
 * marked so nobody mistakes it for a real summary.
 */
export class StubDigestModel implements DigestModel {
  readonly name = "stub-not-ai";
  readonly providerLabel = "a local stand-in, not a real provider";

  /** Leaves every message where it is. */
  async tidy(input: TidyInput): Promise<TidyOutput> {
    return { new_lanes: [], assignments: input.messages.flatMap((m) => (m.lane ? [{ message: m.ref, lane: m.lane }] : [])) };
  }

  async digest(input: DigestInput): Promise<DigestOutput> {
    const nameOf = new Map(input.people.map((p) => [p.ref, p.name]));
    const last = input.messages.slice(-2);
    const decision = [...input.messages].reverse().find((m) => /\b(booked|decided|confirmed|done deal|final)\b/i.test(m.text));
    const questions = input.messages.flatMap((m, i) => {
      if (!m.text.includes("?")) return [];
      const askedOf = input.people.filter((p) => p.ref !== m.author && new RegExp(`\\b${p.name}\\b`, "i").test(m.text)).map((p) => p.ref);
      if (askedOf.length === 0) return [];
      // Answered if one of the people asked spoke later in the topic.
      const answered = input.messages.slice(i + 1).some((later) => askedOf.includes(later.author));
      return [{ message: m.ref, asked_of: askedOf, question: m.text.slice(0, 100), answered }];
    });
    return {
      title: `${input.messages[0]?.text.split(/\s+/).slice(0, 4).join(" ") ?? "Topic"} (stub)`,
      recap: last.map((m) => `[stub] ${nameOf.get(m.author) ?? "Someone"}: ${m.text.slice(0, 80)}`).join("\n"),
      status: decision ? "decided" : "open",
      outcome: decision ? `[stub] ${decision.text.slice(0, 120)}` : null,
      questions,
    };
  }
}
