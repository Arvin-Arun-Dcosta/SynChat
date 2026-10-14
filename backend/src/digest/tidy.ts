import type { TidyInput, TidyOutput } from "./model.js";

/** How much of a conversation one tidy-up looks at. Older messages keep the lanes they have. */
export const TIDY_WINDOW = 80;

/** A message in the tidy window, oldest first, as the server knows it. */
export interface TidyRow {
  id: string;
  topicId: string;
  /** Person reference ("P2"). */
  author: string;
  text: string;
  at: number;
  /** A person put it where it is (a correction, or a send from inside a lane). It is never moved. */
  locked: boolean;
  /** An explicit reply to this message of the window: it goes wherever that message goes. */
  parentId: string | null;
  /** An earlier tidy-up has already looked at it. */
  sorted: boolean;
}

export interface TidyRequest {
  input: TidyInput;
  /** Topic id -> the reference the model was given for it. */
  laneRef: Map<string, string>;
}

/**
 * What the model is shown. Lanes that are established (a tidy-up or a person has
 * confirmed something in them) are listed, and messages already sorted show theirs.
 * Messages the local assigner placed since the last tidy-up show no lane: on the
 * test chats the model sorts better from the text alone than when it is handed the
 * local guess to correct (see the README's measurements).
 */
export function tidyRequest(rows: TidyRow[], people: TidyInput["people"], established: { id: string; title: string }[]): TidyRequest {
  const laneRef = new Map(established.map((l, i) => [l.id, `L${i + 1}`]));
  const messageRef = new Map(rows.map((r, i) => [r.id, `m${i + 1}`]));
  const newest = rows.length ? rows[rows.length - 1]!.at : 0;
  return {
    laneRef,
    input: {
      people,
      lanes: established.map((l) => ({ ref: laneRef.get(l.id)!, title: l.title })),
      messages: rows.map((r, i) => ({
        ref: `m${i + 1}`,
        author: r.author,
        text: r.text,
        minutesAgo: Math.max(0, Math.round((newest - r.at) / 60_000)),
        lane: r.sorted || r.locked ? laneRef.get(r.topicId) : undefined,
        replyTo: r.parentId ? messageRef.get(r.parentId) : undefined,
        locked: r.locked,
      })),
    },
  };
}

export interface TidyPlan {
  /** Message id -> the lane it moves to: a topic id, or a key of `create`. Only messages that change lane. */
  moves: Map<string, string>;
  /** Lanes to create: key -> the model's title for it (uncleaned). */
  create: Map<string, string>;
  /** Lanes the local assigner had opened that the model kept: topic id -> the model's title for it. */
  retitle: Map<string, string>;
}

/**
 * Turn the model's answer into the moves the server will make. The answer is
 * untrusted: anything that refers to a message or lane the model was not given is
 * dropped, and the rules a model must not override are enforced here, not in the
 * prompt. A locked message stays; an explicit reply follows its parent.
 */
export function planTidy(rows: TidyRow[], laneRef: Map<string, string>, out: TidyOutput): TidyPlan {
  const topicByRef = new Map([...laneRef].map(([id, ref]) => [ref, id]));
  const titles = new Map<string, string>();
  for (const n of Array.isArray(out?.new_lanes) ? out.new_lanes.slice(0, TIDY_WINDOW) : []) {
    if (typeof n?.ref === "string" && /^N\d{1,3}$/.test(n.ref) && !titles.has(n.ref)) titles.set(n.ref, typeof n.title === "string" ? n.title : "");
  }

  // Where the model wants each message, by row index. The first valid answer for a message counts.
  const wanted = new Map<number, string>();
  for (const a of Array.isArray(out?.assignments) ? out.assignments.slice(0, rows.length * 2) : []) {
    const k = /^m(\d{1,4})$/.exec(String(a?.message));
    const i = k ? Number(k[1]) - 1 : -1;
    const row = rows[i];
    const ref = String(a?.lane);
    if (!row || wanted.has(i) || row.locked || row.parentId) continue;
    if (topicByRef.has(ref) || titles.has(ref)) wanted.set(i, ref);
  }

  // A lane the model calls new is often one the local assigner has already opened
  // for those same messages. Keep that topic (and its id) instead of replacing it:
  // each new lane takes the unlisted topic that holds most of its messages.
  const overlap: { ref: string; topicId: string; n: number }[] = [];
  for (const [i, ref] of wanted) {
    const topicId = rows[i]!.topicId;
    if (!titles.has(ref) || laneRef.has(topicId)) continue;
    const found = overlap.find((o) => o.ref === ref && o.topicId === topicId);
    if (found) found.n++;
    else overlap.push({ ref, topicId, n: 1 });
  }
  overlap.sort((a, b) => b.n - a.n);
  const taken = new Set<string>();
  const retitle = new Map<string, string>();
  for (const o of overlap) {
    if (topicByRef.has(o.ref) || taken.has(o.topicId)) continue;
    topicByRef.set(o.ref, o.topicId);
    taken.add(o.topicId);
    if (titles.get(o.ref)) retitle.set(o.topicId, titles.get(o.ref)!);
  }

  const moves = new Map<string, string>();
  const create = new Map<string, string>();
  const finalOf = new Map<string, string>(); // message id -> where it ends up
  rows.forEach((row, i) => {
    let target = row.topicId;
    if (row.parentId) target = finalOf.get(row.parentId) ?? row.topicId;
    else if (wanted.has(i)) {
      const ref = wanted.get(i)!;
      target = topicByRef.get(ref) ?? `new:${ref}`;
      if (!topicByRef.has(ref)) create.set(target, titles.get(ref) ?? "");
    }
    finalOf.set(row.id, target);
    if (target !== row.topicId && !row.locked) moves.set(row.id, target);
    else finalOf.set(row.id, row.topicId);
  });
  // A new lane that only replies were going to follow into may have ended up unused.
  for (const key of [...create.keys()]) if (![...moves.values()].includes(key)) create.delete(key);
  return { moves, create, retitle };
}
