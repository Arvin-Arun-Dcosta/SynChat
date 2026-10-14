/**
 * Demo data: four people, two groups with interleaved conversations, and two DMs.
 *
 *   npm run seed            (from the repo root, or --prefix backend)
 *
 * Messages are stored through the same code paths as real ones and then given
 * timestamps spread over the last day or so. Topic lanes are NOT scripted: every
 * message goes through the real embedder and assigner, so what you see is what the
 * assigner actually does with this conversation, mistakes included.
 *
 * Safe to run again: it removes the demo accounts and the chats they created first.
 * It touches nothing else, and refuses to run in production.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { createApp } from "./app.js";
import { newInviteCode } from "./auth/routes.js";
import { loadConfig } from "./config.js";
import { createGroup, findOrCreateDm } from "./conversations/service.js";
import { Db, migrate } from "./db.js";
import { listTopics } from "./lanes/service.js";
import { sendMessage, setReaction } from "./messages/service.js";

const DEMO_DOMAIN = "demo.synchat.example";
const PASSWORD = "synchat-demo-2026";
const PEOPLE = [
  { key: "asha", fullName: "Asha Rao" },
  { key: "ben", fullName: "Ben Okafor" },
  { key: "chidi", fullName: "Chidi Eze" },
  { key: "dev", fullName: "Dev Malhotra" },
] as const;
type Who = (typeof PEOPLE)[number]["key"];

/** One line: seconds after the previous line, who, what, and optional extras. */
type Line = [gap: number, who: Who, text: string, extra?: { replyTo?: string; react?: [Who, string][]; tag?: string }];
/** A burst of conversation that started `minutesAgo`. */
interface Burst {
  minutesAgo: number;
  lines: Line[];
}

const FLATMATES: Burst[] = [
  {
    // Yesterday evening: dinner plans and an assignment, shuffled together.
    minutesAgo: 26 * 60,
    lines: [
      [0, "asha", "who's in for dinner on saturday?"],
      [14, "ben", "me! where though"],
      [9, "chidi", "did anyone start the networks assignment"],
      [21, "asha", "thinking that ramen place near the station"],
      [6, "dev", "not yet, isn't the assignment due friday?"],
      [11, "ben", "the one with the long queue?"],
      [8, "chidi", "thursday midnight actually, check the portal"],
      [5, "asha", "yeah but it moves fast"],
      [13, "dev", "wait what"],
      [4, "dev", "i thought friday"],
      [17, "chidi", "nope. question 3 of the assignment is brutal btw"],
      [9, "ben", "what time for the ramen place"],
      [22, "asha", "8?"],
      [6, "ben", "8 works"],
      [15, "dev", "is question 3 the sliding window proof", { tag: "q3" }],
      [7, "chidi", "yes"],
      [19, "asha", "chidi dev you coming to dinner?"],
      [12, "chidi", "yep count me in for dinner"],
      [31, "dev", "can't, family thing :("],
      [140, "asha", "booked a table for 3 at 8", { react: [["ben", "👍"], ["chidi", "👍"]] }],
    ],
  },
  {
    minutesAgo: 22 * 60,
    lines: [
      [0, "dev", "ok question 3 done finally. the trick is to induct on the window size", { tag: "q3done" }],
      [25, "chidi", "ohh that makes sense", { replyTo: "q3done" }],
      [13, "ben", "can you explain tomorrow before class"],
      [9, "dev", "sure"],
    ],
  },
  {
    minutesAgo: 5 * 60,
    lines: [
      [0, "asha", "btw are we still doing the hampi trip in december"],
      [34, "ben", "i'm in if it's after the 15th"],
      [20, "chidi", "same, exams end on the 14th"],
      [12, "asha", "ok let's say 18th to 21st for hampi"],
      [9, "dev", "works"],
      [15, "ben", "train or bus for hampi?"],
      [22, "asha", "train, i'll check tickets tonight", { react: [["ben", "🚆"]] }],
    ],
  },
  {
    // Half an hour ago, while Asha was away: these are her unread messages.
    minutesAgo: 28,
    lines: [
      [0, "ben", "is the wifi down for anyone else"],
      [18, "chidi", "yes!! since morning"],
      [9, "dev", "reminder rent is due on the 5th, please send me your share"],
      [12, "ben", "i restarted the wifi router twice"],
      [7, "chidi", "how much is rent this month"],
      [15, "dev", "9500 each for rent, plus electricity"],
      [11, "ben", "@asha did you call the wifi provider?"],
      [20, "chidi", "sending my rent now"],
    ],
  },
];

const PROJECT: Burst[] = [
  {
    minutesAgo: 3 * 60,
    lines: [
      [0, "chidi", "slides for thursday, who is doing which part"],
      [13, "dev", "i can take the intro and the problem statement slides"],
      [9, "asha", "the login page is broken on staging btw"],
      [8, "chidi", "broken how"],
      [7, "asha", "it just spins after you submit the login form"],
      [10, "dev", "is that the token change i merged yesterday"],
      [12, "chidi", "ok then i'll do the architecture slides"],
      [60, "dev", "found it, the cookie name changed and the login page still reads the old one"],
      [7, "asha", "i can fix the frontend side of the login", { react: [["dev", "🙏"]] }],
      [25, "chidi", "how many slides each"],
      [8, "dev", "3 slides max, we only get 10 minutes"],
    ],
  },
];

const config = loadConfig();
if (config.isProd) {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}
const db = new Db(config.databaseUrl);
await migrate(db);
// No server is started: this only borrows the app's services. Nothing is pushed or sent to a model.
const app = createApp(config, db, { pushSender: null, digestModel: null });
const lanes = app.ctx.lanes!;

// --- Start clean: remove what an earlier run of this script created. ---
const old = await db.query("SELECT id FROM users WHERE email LIKE $1", [`%@${DEMO_DOMAIN}`]);
if (old.rows.length > 0) {
  const ids = old.rows.map((r) => r.id);
  await db.query("DELETE FROM conversations WHERE created_by = ANY($1)", [ids]);
  await db.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
}

// --- People. A username someone else already took gets a suffix. ---
const hash = await bcrypt.hash(PASSWORD, config.bcryptCost);
const id = {} as Record<Who, string>;
const username = {} as Record<Who, string>;
for (const p of PEOPLE) {
  const taken = await db.query("SELECT 1 FROM users WHERE username = $1", [p.key]);
  username[p.key] = taken.rows[0] ? `${p.key}_demo` : p.key;
  const { rows } = await db.query(
    "INSERT INTO users (email, username, full_name, password_hash, invite_code) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [`${p.key}@${DEMO_DOMAIN}`, username[p.key], p.fullName, hash, newInviteCode()],
  );
  id[p.key] = rows[0]!.id;
}

/** Store a conversation's bursts as real messages, then move them back in time. */
async function play(conversationId: string, bursts: Burst[]): Promise<void> {
  const tags = new Map<string, string>();
  let first: Date | null = null;
  let last = new Date();
  for (const burst of bursts) {
    let at = Date.now() - burst.minutesAgo * 60_000;
    for (const [gap, who, raw, extra] of burst.lines) {
      at += gap * 1000;
      // Mentions are written with the short name; use whatever username the person ended up with.
      const text = raw.replace(/@(asha|ben|chidi|dev)\b/g, (_, k: Who) => `@${username[k]}`);
      const { message } = await sendMessage(db, {
        id: randomUUID(),
        conversationId,
        senderId: id[who],
        text,
        replyToId: extra?.replyTo ? tags.get(extra.replyTo) : null,
      });
      last = new Date(at);
      first ??= last;
      await db.query("UPDATE messages SET created_at = $2 WHERE id = $1", [message.id, last]);
      if (extra?.tag) tags.set(extra.tag, message.id);
      for (const [reactor, emoji] of extra?.react ?? []) await setReaction(db, message.id, id[reactor], emoji, true);
    }
  }
  await db.query("UPDATE conversations SET last_message_at = $2, created_at = $3 WHERE id = $1", [conversationId, last, new Date(first!.getTime() - 60_000)]);
  await db.query("UPDATE conversation_members SET joined_at = $2 WHERE conversation_id = $1", [conversationId, new Date(first!.getTime() - 60_000)]);
  // Everyone has read everything, unless set otherwise below.
  await db.query("UPDATE conversation_members cm SET last_read_seq = c.last_seq FROM conversations c WHERE c.id = cm.conversation_id AND c.id = $1", [conversationId]);
}

const flatmates = await createGroup(db, id.asha, "Flatmates", [id.ben, id.chidi, id.dev]);
await play(flatmates, FLATMATES);
// Asha has not seen the last burst (the wifi and rent talk).
const unreadFrom = FLATMATES.slice(0, -1).reduce((n, b) => n + b.lines.length, 0);
await db.query("UPDATE conversation_members SET last_read_seq = $3 WHERE conversation_id = $1 AND user_id = $2", [flatmates, id.asha, unreadFrom]);

const project = await createGroup(db, id.asha, "Networks project", [id.chidi, id.dev]);
await play(project, PROJECT);

const withBen = (await findOrCreateDm(db, id.asha, id.ben)).id;
await play(withBen, [
  {
    minutesAgo: 2 * 24 * 60,
    lines: [
      [0, "ben", "did you get the notes from monday's lecture"],
      [40, "asha", "yes, sending them now"],
      [65, "ben", "lifesaver, thanks", { react: [["asha", "❤️"]] }],
    ],
  },
]);
const withChidi = (await findOrCreateDm(db, id.asha, id.chidi)).id;
await play(withChidi, [{ minutesAgo: 40, lines: [[0, "chidi", "are you home? forgot my keys"]] }]);
await db.query("UPDATE conversation_members SET last_read_seq = 0 WHERE conversation_id = $1 AND user_id = $2", [withChidi, id.asha]);
// DMs are found by created_by too when cleaning up next time.
await db.query("UPDATE conversations SET created_by = $2 WHERE id = ANY($1)", [[withBen, withChidi], id.asha]);

// --- Now the real pipeline: embed every message and let the assigner sort the groups into lanes. ---
console.log("Embedding messages and assigning topic lanes (the model loads first)...");
await lanes.warmUp();
const queued = await lanes.recover();
await lanes.idle();

console.log(`\nSeeded ${queued} messages. Log in at http://localhost:5173 with any of:\n`);
for (const p of PEOPLE) console.log(`  ${username[p.key].padEnd(12)} ${p.fullName}`);
console.log(`\n  password for all four: ${PASSWORD}\n`);
for (const [name, conversationId] of [["Flatmates", flatmates], ["Networks project", project]] as const) {
  const topics = await listTopics(db, conversationId);
  console.log(`${name}: the assigner made ${topics.length} lanes`);
  for (const t of [...topics].sort((a, b) => a.firstSeq - b.firstSeq)) console.log(`  ${String(t.messageCount).padStart(2)} messages  ${t.title}`);
}

await app.close();
await db.close();
