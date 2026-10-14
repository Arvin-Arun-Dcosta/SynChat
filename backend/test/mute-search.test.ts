import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mentionedUsernames } from "../src/messages/mentions.js";
import { toTsQuery } from "../src/search/service.js";
import { FakeEmbedder, connect, dm, group, resetDb, send, signup, startApp, type TestApp, type TestSocket, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, chidi: TestUser, mallory: TestUser;
let groupId: string, dinnerTopic: string, wifiTopic: string;
const open: TestSocket[] = [];
const sock = async (user: TestUser) => {
  const s = await connect(t, user.cookie);
  open.push(s);
  return s;
};
// "eating" and "food" mean "dinner" to the stand-in model, so a query can match a
// message by meaning with no word in common.
const embedder = new FakeEmbedder({ eating: "dinner", food: "dinner", internet: "wifi" });

beforeAll(async () => {
  t = await startApp({}, { lanes: true, embedder });
});
afterAll(() => t.close());

const settle = () => t.app.ctx.lanes!.idle();
const say = async (user: TestUser, text: string, extra: Record<string, unknown> = {}, conversationId = groupId) => {
  const res = await send(user, conversationId, text, extra);
  expect(res.status).toBe(201);
  await settle();
  return res.body.message as { id: string; seq: number; mentions: string[] };
};
const topicOf = async (id: string) => (await t.db.query("SELECT topic_id FROM messages WHERE id = $1", [id])).rows[0]!.topic_id as string;
const unread = async (user: TestUser) => (await user.http.get(`/api/conversations/${groupId}`)).body.conversation.unreadCount as number;
const mute = (user: TestUser, topicId: string, muted = true) => user.http.put(`/api/topics/${topicId}/mute`).send({ muted });

beforeEach(async () => {
  for (const s of open.splice(0)) s.close();
  await settle();
  await resetDb(t.db);
  [asha, ben, chidi, mallory] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi"), signup(t, "mallory")]);
  groupId = await group(asha, "Flat", [ben, chidi]);
  dinnerTopic = await topicOf((await say(asha, "who is cooking dinner tonight")).id);
  wifiTopic = await topicOf((await say(asha, "the wifi router keeps dropping the connection")).id);
  expect(dinnerTopic).not.toBe(wifiTopic);
});

describe("mentions", () => {
  it("parses @usernames and nothing else", () => {
    expect(mentionedUsernames("@ben and @chidi.e, also (@asha_r)!")).toEqual(["ben", "chidi.e", "asha_r"]);
    expect(mentionedUsernames("mail me at ben@example.com or a@b")).toEqual([]);
    expect(mentionedUsernames("@Ben @ben @BEN.")).toEqual(["ben"]);
    expect(mentionedUsernames(null)).toEqual([]);
  });

  it("records mentions of members only, and follows edits", async () => {
    const m = await say(asha, "@ben @mallory @nobody @asha can someone restart the wifi router", { topicId: wifiTopic });
    expect(m.mentions).toEqual([ben.id]); // mallory is not in the group; asha is the sender
    const edited = await asha.http.patch(`/api/messages/${m.id}`).send({ text: "@chidi can you restart the wifi router" });
    expect(edited.body.message.mentions).toEqual([chidi.id]);
  });
});

describe("topic mute", () => {
  it("stops a muted topic counting toward my unread badge, and only mine", async () => {
    expect(await unread(ben)).toBe(2);
    const res = await mute(ben, wifiTopic);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ topicId: wifiTopic, muted: true, conversation: { id: groupId, unreadCount: 1, mutedTopicIds: [wifiTopic] } });
    expect((await chidi.http.get(`/api/conversations/${groupId}`)).body.conversation.mutedTopicIds).toEqual([]);
    await say(asha, "wifi is back", { topicId: wifiTopic });
    await say(asha, "pasta tonight", { topicId: dinnerTopic });
    expect(await unread(ben)).toBe(2); // dinner x2; the three wifi messages are muted
    expect(await unread(chidi)).toBe(4);

    const forBen = (await ben.http.get(`/api/conversations/${groupId}/topics`)).body.topics;
    expect(Object.fromEntries(forBen.map((x: { id: string; muted: boolean }) => [x.id, x.muted]))).toEqual({ [wifiTopic]: true, [dinnerTopic]: false });
    const forChidi = (await chidi.http.get(`/api/conversations/${groupId}/topics`)).body.topics;
    expect(forChidi.every((x: { muted: boolean }) => !x.muted)).toBe(true);
  });

  it("still counts a message that mentions me directly", async () => {
    await mute(ben, wifiTopic);
    expect(await unread(ben)).toBe(1);
    await say(asha, "@ben did you restart the wifi router", { topicId: wifiTopic });
    await say(asha, "@chidi you too", { topicId: wifiTopic });
    expect(await unread(ben)).toBe(2); // the mention of ben got through; the one of chidi did not
  });

  it("counts again after unmuting", async () => {
    await mute(ben, wifiTopic);
    expect((await mute(ben, wifiTopic, false)).body.conversation.unreadCount).toBe(2);
    await mute(ben, wifiTopic, false); // harmless to repeat
    expect(await unread(ben)).toBe(2);
  });

  it("is ignored while the member has topic mute switched off in settings", async () => {
    await mute(ben, wifiTopic);
    expect(await unread(ben)).toBe(1);
    const off = await ben.http.patch("/api/auth/smart").send({ topicMute: false });
    expect(off.body.user.smart).toMatchObject({ topicMute: false, lanes: true, search: true });
    expect(await unread(ben)).toBe(2);
    expect((await ben.http.get(`/api/conversations/${groupId}`)).body.conversation.mutedTopicIds).toEqual([]);
    await ben.http.patch("/api/auth/smart").send({ topicMute: true });
    expect(await unread(ben)).toBe(1); // the mute itself was remembered
  });

  it("tells my other devices, and nobody else", async () => {
    const [mine, theirs] = await Promise.all([sock(ben), sock(asha)]);
    await mute(ben, wifiTopic);
    expect(await mine.waitFor("topic:mute")).toEqual({ conversationId: groupId, topicId: wifiTopic, muted: true });
    expect((await mine.waitFor("conversation:updated")).conversation.unreadCount).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(theirs.events.filter((e) => e.event === "topic:mute" || e.event === "conversation:updated")).toEqual([]);
  });

  it("is refused for a topic in a conversation I am not in", async () => {
    expect((await mute(mallory, wifiTopic)).status).toBe(404);
    expect((await mute(ben, "not-a-uuid")).status).toBe(400);
    expect((await ben.http.put(`/api/topics/${wifiTopic}/mute`).send({ muted: "yes" })).status).toBe(400);
    expect((await t.db.query("SELECT count(*)::int AS n FROM topic_mutes")).rows[0]!.n).toBe(0);
  });
});

describe("smart feature switches", () => {
  it("default to on, store only what is off, and reject unknown keys", async () => {
    expect((await asha.http.get("/api/auth/me")).body.user.smart).toEqual({ lanes: true, topicMute: true, search: true, catchUp: true, status: true, inbox: true });
    await asha.http.patch("/api/auth/smart").send({ lanes: false, inbox: false });
    await asha.http.patch("/api/auth/smart").send({ inbox: true });
    expect((await t.db.query("SELECT smart FROM users WHERE id = $1", [asha.id])).rows[0]!.smart).toEqual({ lanes: false });
    expect((await asha.http.patch("/api/auth/smart").send({ admin: true })).status).toBe(400);
  });

  it("keeps every change when several switches are flipped at the same moment", async () => {
    const all = ["lanes", "topicMute", "search", "catchUp", "status", "inbox"];
    await Promise.all(all.map((feature) => asha.http.patch("/api/auth/smart").send({ [feature]: false })));
    expect((await asha.http.get("/api/auth/me")).body.user.smart).toEqual(Object.fromEntries(all.map((f) => [f, false])));
    await Promise.all(all.map((feature) => asha.http.patch("/api/auth/smart").send({ [feature]: true })));
    expect((await t.db.query("SELECT smart FROM users WHERE id = $1", [asha.id])).rows[0]!.smart).toEqual({});
    expect((await asha.http.patch("/api/auth/smart").send({ lanes: "no" })).status).toBe(400);
  });
});

describe("search", () => {
  const find = async (user: TestUser, q: string) => (await user.http.get(`/api/search?q=${encodeURIComponent(q)}`)).body as {
    semantic: boolean;
    groups: { conversationId: string; topic: { id: string; title: string } | null; hits: { message: { id: string; text: string }; matched: string }[] }[];
  };
  const texts = (r: Awaited<ReturnType<typeof find>>) => r.groups.flatMap((g) => g.hits.map((h) => h.message.text));

  it("builds a safe prefix query from whatever is typed", () => {
    expect(toTsQuery("Ramen  book")).toBe("'ramen':* | 'book':*");
    // Filler words are dropped when there is anything else to search for...
    expect(toTsQuery("where are we going to eat this weekend")).toBe("'eat':* | 'weekend':*");
    // ...but a query made only of them is still searched as typed.
    expect(toTsQuery("what is this")).toBe("'what':* | 'is':* | 'this':*");
    expect(toTsQuery("a'); DROP TABLE messages;-- & | !")).toBe("'drop':* | 'table':* | 'messages':*");
    expect(toTsQuery("!!! ?")).toBeNull();
  });

  it("finds a message by its words, including a prefix of a word", async () => {
    const r = await find(asha, "rout");
    expect(texts(r)).toEqual(["the wifi router keeps dropping the connection"]);
    expect(r.groups[0]!.hits[0]!.matched).toBe("keyword");
  });

  it("finds a message by meaning when no word matches", async () => {
    const r = await find(asha, "eating food");
    expect(r.semantic).toBe(true);
    expect(texts(r)).toContain("who is cooking dinner tonight");
    expect(r.groups[0]!.hits[0]).toMatchObject({ matched: "meaning", message: { text: "who is cooking dinner tonight" } });
    expect(texts(r)).not.toContain("the wifi router keeps dropping the connection");
  });

  it("ranks a message found both ways first, and groups results by topic", async () => {
    await say(ben, "dinner at the ramen place", { topicId: dinnerTopic });
    await say(chidi, "is the internet down", { topicId: wifiTopic });
    const r = await find(asha, "dinner internet");
    const groups = Object.fromEntries(r.groups.map((g) => [g.topic!.id, g.hits.map((h) => h.message.text).sort()]));
    expect(groups).toEqual({
      [dinnerTopic]: ["dinner at the ramen place", "who is cooking dinner tonight"],
      // The router message shares neither a word nor enough meaning with the query.
      [wifiTopic]: ["is the internet down"],
    });
    expect(r.groups.find((g) => g.topic!.id === dinnerTopic)!.topic!.title).toBe("Who is cooking dinner tonight");
    expect(r.groups.flatMap((g) => g.hits).filter((h) => h.matched === "both").length).toBeGreaterThanOrEqual(2);
  });

  it("puts DM results in their own group, with no topic", async () => {
    const id = await dm(asha, ben);
    await say(asha, "see you at the station at nine", {}, id);
    const r = await find(ben, "station");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ conversationId: id, topic: null });
  });

  it("only ever returns messages from the caller's own conversations", async () => {
    const secret = await group(mallory, "Elsewhere", []);
    await say(mallory, "the secret dinner is at the wifi router", {}, secret);
    for (const q of ["secret", "dinner", "wifi router", "eating food"]) {
      const mine = await find(asha, q);
      expect(mine.groups.every((g) => g.conversationId === groupId), q).toBe(true);
      expect(texts(mine).join(" ")).not.toContain("secret");
      const theirs = await find(mallory, q);
      expect(theirs.groups.every((g) => g.conversationId === secret), q).toBe(true);
    }
  });

  it("stops returning a group's messages to someone who has been removed from it", async () => {
    expect(texts(await find(chidi, "dinner"))).toHaveLength(1);
    await asha.http.delete(`/api/conversations/${groupId}/members/${chidi.id}`);
    expect((await find(chidi, "dinner")).groups).toEqual([]);
    expect((await find(chidi, "eating food")).groups).toEqual([]);
  });

  it("cannot find a deleted message by words or by meaning", async () => {
    const m = await say(ben, "dinner at the ramen place", { topicId: dinnerTopic });
    expect(texts(await find(asha, "ramen"))).toHaveLength(1);
    await ben.http.delete(`/api/messages/${m.id}`);
    expect((await find(asha, "ramen")).groups).toEqual([]);
    expect(texts(await find(asha, "eating food"))).toEqual(["who is cooking dinner tonight"]);
    expect((await t.db.query("SELECT count(*)::int AS n FROM message_embeddings WHERE message_id = $1", [m.id])).rows[0]!.n).toBe(0);
  });

  it("finds an edited message by its new text only", async () => {
    const m = await say(ben, "dinner at the ramen place", { topicId: dinnerTopic });
    await ben.http.patch(`/api/messages/${m.id}`).send({ text: "dinner at the dosa place" });
    await settle();
    expect((await find(asha, "ramen")).groups).toEqual([]);
    expect(texts(await find(asha, "dosa"))).toEqual(["dinner at the dosa place"]);
  });

  it("falls back to keywords when the embedding model is unavailable", async () => {
    const original = embedder.embed.bind(embedder);
    embedder.embed = () => Promise.reject(new Error("model not available"));
    try {
      const r = await find(asha, "dinner");
      expect(r.semantic).toBe(false);
      expect(texts(r)).toEqual(["who is cooking dinner tonight"]);
      expect((await find(asha, "eating food")).groups).toEqual([]);
    } finally {
      embedder.embed = original;
    }
  });

  it("validates the query, needs a session, and respects the member's own switch", async () => {
    expect((await asha.http.get("/api/search?q=a")).status).toBe(400);
    expect((await asha.http.get("/api/search")).status).toBe(400);
    expect((await asha.http.get(`/api/search?q=${"x".repeat(201)}`)).status).toBe(400);
    expect((await fetch(`${t.url}/api/search?q=dinner`)).status).toBe(401);
    await asha.http.patch("/api/auth/smart").send({ search: false });
    expect((await asha.http.get("/api/search?q=dinner")).status).toBe(403);
  });
});
