import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Person } from "../src/lanes/text.js";

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const IRC_DIR = path.join(EVAL_DIR, "data", "irc", "data");
export const CASUAL_DIR = path.join(EVAL_DIR, "casual");

/** One message of an evaluation stream, in the order it was sent. */
export interface StreamMessage {
  senderId: string;
  /** Milliseconds from an arbitrary origin. */
  at: number;
  text: string;
  /** Join/quit/rename lines. The app never assigns system lines a topic, so neither does the eval. */
  system: boolean;
  /** Gold cluster id, or null for warm-up messages that are not scored. */
  gold: string | null;
  /**
   * Cluster id where it is known at all: scored messages, plus warm-up messages that
   * an annotated message links back to. Used as history when fitting weights.
   */
  cluster: string | null;
}

export interface Stream {
  file: string;
  messages: StreamMessage[];
  /** Everyone who can be addressed by name, as of the end of the stream. */
  people: Person[];
}

// --- Ubuntu IRC (Kummerfeld et al., 2019) -----------------------------------

const IRC_LINE = /^\[(\d{2}):(\d{2})\] <([^>]*)> ?(.*)$/;
const IRC_ACTION = /^\[(\d{2}):(\d{2})\]\s+\* (\S+) ?(.*)$/;

/**
 * Each file has 1000 lines of unannotated context followed by the annotated lines.
 * We replay the last `warmup` context lines so topics already exist when scoring
 * starts, then score the annotated lines only, as the reference tools do.
 */
export function loadIrc(split: "dev" | "test", warmup = 300): Stream[] {
  const dir = path.join(IRC_DIR, split);
  if (!fs.existsSync(dir)) {
    throw new Error(`IRC data not found at ${dir}. Run: npm run eval:data`);
  }
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".ascii.txt")).sort();
  return names.map((name) => {
    const base = name.replace(".ascii.txt", "");
    const lines = fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter((l) => l.length > 0);

    // Gold: connected components of the reply graph, restricted to annotated lines.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    let cutoff = Infinity;
    for (const row of fs.readFileSync(path.join(dir, `${base}.annotation.txt`), "utf8").split("\n")) {
      const nums = row.split(/\s+/).filter((t) => /^\d+$/.test(t)).map(Number);
      if (nums.length < 2) continue;
      const [a, b] = [Math.min(nums[0]!, nums[1]!), Math.max(nums[0]!, nums[1]!)];
      cutoff = Math.min(cutoff, b);
      parent.set(find(a), find(b));
    }

    const start = Math.max(0, cutoff - warmup);
    const messages: StreamMessage[] = [];
    const nicks = new Set<string>();
    let day = 0;
    let lastMinute = -1;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]!;
      const m = IRC_LINE.exec(line) ?? IRC_ACTION.exec(line);
      let minute = lastMinute < 0 ? 0 : lastMinute;
      if (m) {
        minute = Number(m[1]) * 60 + Number(m[2]);
        if (lastMinute >= 0 && minute < lastMinute - 600) day++; // passed midnight
        lastMinute = minute;
      }
      const sender = m ? m[3]! : "=== system";
      if (m && sender) nicks.add(sender);
      messages.push({
        senderId: sender || "unknown",
        // Logs only have minute resolution; spread lines within a minute by their order.
        at: (day * 1440 + minute) * 60_000 + (i % 60) * 500,
        text: m ? m[4]! : line,
        system: !m,
        gold: i >= cutoff ? String(find(i)) : null,
        cluster: i >= cutoff || parent.has(i) ? String(find(i)) : null,
      });
    }
    return { file: `${split}/${base}`, messages, people: [...nicks].map((n) => ({ id: n, names: [n.toLowerCase()] })) };
  });
}

// --- Hand-written casual chats ------------------------------------------------

const CASUAL_LINE = /^\+(\d+) (\S+) (\S+) (.+)$/;

export function loadCasual(split: "dev" | "test"): Stream[] {
  const names = fs.readdirSync(CASUAL_DIR).filter((f) => f.startsWith(`${split}-`) && f.endsWith(".txt")).sort();
  return names.map((name) => {
    const messages: StreamMessage[] = [];
    const people = new Set<string>();
    let at = 0;
    for (const line of fs.readFileSync(path.join(CASUAL_DIR, name), "utf8").split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const m = CASUAL_LINE.exec(line);
      if (!m) throw new Error(`${name}: cannot parse "${line}"`);
      at += Number(m[1]) * 1000;
      people.add(m[2]!);
      messages.push({ senderId: m[2]!, at, text: m[4]!, system: false, gold: m[3]!, cluster: m[3]! });
    }
    return { file: `casual/${name.replace(".txt", "")}`, messages, people: [...people].map((p) => ({ id: p, names: [p] })) };
  });
}
