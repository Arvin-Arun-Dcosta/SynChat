import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { centredCosine, shrunkMean } from "../src/embedding/centre.js";
import { recentWithSimilarity } from "../src/lanes/service.js";
import { FakeEmbedder, connect, dm, group, resetDb, send, signup, startApp, type TestApp, type TestSocket, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, chidi: TestUser, mallory: TestUser;
let groupId: string;
const open: TestSocket[] = [];
const sock = async (user: TestUser) => {
  const s = await connect(t, user.cookie);
  open.push(s);
  return s;
};

beforeAll(async () => {
  t = await startApp({}, { lanes: true });
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const s of open.splice(0)) s.close();
  await t.app.ctx.lanes!.idle();
  await resetDb(t.db);
  [asha, ben, chidi, mallory] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi"), signup(t, "mallory")]);
  groupId = await group(asha, "Flat", [ben, chidi]);
});

const settle = () => t.app.ctx.lanes!.idle();
const say = async (user: TestUser, text: string, extra: Record<string, unknown> = {}) => {
  const res = await send(user, groupId, text, extra);
  expect(res.status).toBe(201);
  return res.body.message as { id: string; seq: number; rev: number; topicId: string | null };
};
const topics = async (user: TestUser = asha) => (await user.http.get(`/api/conversations/${groupId}/topics`)).body.topics as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const topicOf = async (id: string) => (await t.db.query("SELECT topic_id, topic_source FROM messages WHERE id = $1", [id])).rows[0]!;

describe("assignment", () => {
  it("never makes sending wait: the message is stored and delivered with no topic, then the topic follows as its own event", async () => {
    const b = await sock(ben);
    const sent = await say(asha, "who is cooking dinner tonight");
    expect(sent.topicId).toBeNull();
    const delivered = await b.waitFor("message:new");
    expect(delivered.message.topicId).toBeNull();

    const update = await b.waitFor("lanes:update");
    expect(update).toMatchObject({ conversationId: groupId, rev: sent.rev + 1, removed: [] });
    expect(update.assignments).toEqual([{ messageId: sent.id, topicId: update.topics[0].id }]);
    expect(update.topics[0]).toMatchObject({ title: "Who is cooking dinner tonight", titleSource: "auto", messageCount: 1 });
    // The two events arrived in that order.
    const order = b.events.map((e) => e.event).filter((e) => e === "message:new" || e === "lanes:update");
    expect(order).toEqual(["message:new", "lanes:update"]);
  });

  it("gives every group message a topic, visible the same way to every member", async () => {
    for (const [who, text] of [[asha, "the wifi router is broken again"], [ben, "did you restart the wifi router"], [chidi, "yes"]] as const) await say(who, text);
    await settle();
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND kind = 'user' AND topic_id IS NULL", [groupId]);
    expect(rows[0]!.n).toBe(0);
    const forAsha = await topics(asha);
    const forChidi = await topics(chidi);
    expect(forAsha.map((x) => [x.id, x.title, x.messageCount])).toEqual(forChidi.map((x) => [x.id, x.title, x.messageCount]));
    expect(forAsha.reduce((n, x) => n + x.messageCount, 0)).toBe(3);
  });

  it("separates two interleaved conversations", async () => {
    const lines: [TestUser, string, string][] = [
      [asha, "rent", "the rent payment is due on friday"],
      [ben, "wifi", "the wifi router keeps dropping the connection"],
      [chidi, "rent", "how much is the rent payment this month"],
      [asha, "wifi", "restart the wifi router and check the connection"],
      [ben, "rent", "rent payment is 9500 each this month"],
      [chidi, "wifi", "the router connection dropped again after the restart"],
    ];
    const ids: Record<string, string[]> = { rent: [], wifi: [] };
    for (const [who, label, text] of lines) ids[label]!.push((await say(who, text)).id);
    await settle();
    const rent = new Set(await Promise.all(ids.rent!.map(async (id) => (await topicOf(id)).topic_id)));
    const wifi = new Set(await Promise.all(ids.wifi!.map(async (id) => (await topicOf(id)).topic_id)));
    expect(rent.size).toBe(1);
    expect(wifi.size).toBe(1);
    expect([...rent][0]).not.toBe([...wifi][0]);
  });

  it("assigns in sequence order, one message at a time", async () => {
    const sent = await Promise.all(Array.from({ length: 12 }, (_, i) => say([asha, ben, chidi][i % 3]!, `message number ${i}`)));
    await settle();
    // Each assignment took the next rev, in the same order as the messages' seq.
    const { rows } = await t.db.query("SELECT seq, rev FROM messages WHERE conversation_id = $1 AND kind = 'user' ORDER BY seq", [groupId]);
    expect(rows.map((r) => r.seq)).toEqual(sent.map((s) => s.seq).sort((a, b) => a - b));
    const revs = rows.map((r) => r.rev as number);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(12);
  });

  it("puts an explicit reply in the topic of the message it replies to, whatever it says", async () => {
    const dinner = await say(asha, "who is cooking dinner tonight");
    await say(ben, "the wifi router keeps dropping the connection");
    await say(chidi, "restart the wifi router then");
    await settle();
    const reply = await say(ben, "the wifi router is in my room", { replyToId: dinner.id });
    await settle();
    expect(await topicOf(reply.id)).toEqual({ topic_id: (await topicOf(dinner.id)).topic_id, topic_source: "reply" });
  });

  it("pins a message sent from inside a lane to that topic, immediately", async () => {
    const dinner = await say(asha, "who is cooking dinner tonight");
    await say(ben, "the wifi router keeps dropping the connection");
    await settle();
    const dinnerTopic = (await topicOf(dinner.id)).topic_id as string;
    const pinned = await say(chidi, "the wifi router is next to the stove", { topicId: dinnerTopic });
    expect(pinned.topicId).toBe(dinnerTopic); // already set in the send response
    await settle();
    expect(await topicOf(pinned.id)).toEqual({ topic_id: dinnerTopic, topic_source: "lane" });
  });

  it("refuses to pin to a topic from another conversation", async () => {
    const other = await group(mallory, "Elsewhere", []);
    await send(mallory, other, "a topic in another group");
    await settle();
    const foreign = (await t.db.query("SELECT id FROM topics WHERE conversation_id = $1", [other])).rows[0]!.id;
    expect((await send(asha, groupId, "sneaky", { topicId: foreign })).status).toBe(400);
    expect((await send(asha, groupId, "made up", { topicId: randomUUID() })).status).toBe(400);
  });

  it("does not create topics in DMs, but still embeds DM messages for search", async () => {
    const id = await dm(asha, ben);
    const m = (await send(asha, id, "see you at the station at nine")).body.message;
    await settle();
    expect((await topicOf(m.id)).topic_id).toBeNull();
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM message_embeddings WHERE message_id = $1", [m.id]);
    expect(rows[0]!.n).toBe(1);
    expect((await asha.http.get(`/api/conversations/${id}/topics`)).body.topics).toEqual([]);
  });

  it("still assigns when the embedding model is unavailable", async () => {
    const noModel = await startApp({}, { lanes: true });
    // Replace the embedder with one that always fails, as when the model cannot load.
    (noModel.app.ctx.lanes as unknown as { embedder: { embed: () => Promise<never>; model: string } }).embedder = {
      model: "broken",
      embed: () => Promise.reject(new Error("model not available")),
    };
    try {
      await resetDb(noModel.db);
      const [a, b] = await Promise.all([signup(noModel, "asha"), signup(noModel, "ben")]);
      const id = await group(a, "Flat", [b]);
      const first = (await send(a, id, "who is cooking dinner tonight")).body.message;
      const second = (await send(b, id, "me")).body.message;
      await noModel.app.ctx.lanes!.idle();
      const { rows } = await noModel.db.query("SELECT id, topic_id FROM messages WHERE id = ANY($1)", [[first.id, second.id]]);
      expect(rows.every((r) => r.topic_id !== null)).toBe(true);
      expect(new Set(rows.map((r) => r.topic_id)).size).toBe(1); // "me" follows the question
    } finally {
      await noModel.close();
    }
  });

  it("re-queues messages that were left without a topic by a restart", async () => {
    const m = await say(asha, "who is cooking dinner tonight");
    await settle();
    await t.db.query("UPDATE messages SET topic_id = NULL, topic_source = NULL WHERE id = $1", [m.id]);
    await t.db.query("DELETE FROM topics WHERE conversation_id = $1", [groupId]);
    expect(await t.app.ctx.lanes!.recover()).toBe(1);
    await settle();
    expect((await topicOf(m.id)).topic_id).not.toBeNull();
  });
});

describe("similarity", () => {
  it("is computed in SQL exactly as the offline evaluation computes it", async () => {
    const texts = ["the wifi router is broken again", "who is cooking dinner tonight", "restart the wifi router please", "pasta for dinner", "ok"];
    for (const text of texts) await say(asha, text);
    await settle();
    const embedder = new FakeEmbedder();
    const vectors = await embedder.embed(texts);
    const [query] = await embedder.embed(["is the wifi router fixed yet"]);
    const rows = await recentWithSimilarity(t.db, groupId, 1_000_000, query!);
    expect(rows.map((r) => r.text)).toEqual([...texts].reverse());

    const mean = shrunkMean(vectors, 384);
    rows.forEach((row, i) => {
      const expected = centredCosine(query!, vectors[texts.length - 1 - i]!, mean);
      expect(row.sim, row.text!).toBeCloseTo(expected, 4);
    });
    // And the centring matters: the related line scores clearly above the unrelated ones.
    const byText = Object.fromEntries(rows.map((r) => [r.text, r.sim!]));
    expect(byText["restart the wifi router please"]).toBeGreaterThan(byText["pasta for dinner"]! + 0.3);
  });

  it("is null without an embedding on either side", async () => {
    await say(asha, "who is cooking dinner tonight");
    await settle();
    expect((await recentWithSimilarity(t.db, groupId, 1_000_000, null))[0]!.sim).toBeNull();
    await t.db.query("DELETE FROM message_embeddings");
    const [query] = await new FakeEmbedder().embed(["dinner"]);
    expect((await recentWithSimilarity(t.db, groupId, 1_000_000, query!))[0]!.sim).toBeNull();
  });
});

describe("the lane view", () => {
  it("lists only one topic's messages, with pagination, and counts unread per topic", async () => {
    const dinner = await say(asha, "who is cooking dinner tonight");
    const wifi = await say(ben, "the wifi router keeps dropping the connection");
    await settle();
    const dinnerTopic = (await topicOf(dinner.id)).topic_id;
    const wifiTopic = (await topicOf(wifi.id)).topic_id;
    for (let i = 0; i < 5; i++) await say(asha, `dinner detail ${i}`, { topicId: dinnerTopic });
    await settle();

    const page = (await chidi.http.get(`/api/conversations/${groupId}/messages?topicId=${dinnerTopic}&limit=4`)).body;
    expect(page.messages.map((m: { text: string }) => m.text)).toEqual(["dinner detail 1", "dinner detail 2", "dinner detail 3", "dinner detail 4"]);
    expect(page.hasMore).toBe(true);
    const older = (await chidi.http.get(`/api/conversations/${groupId}/messages?topicId=${dinnerTopic}&limit=4&before=${page.messages[0].seq}`)).body;
    expect(older.messages.map((m: { text: string }) => m.text)).toEqual(["who is cooking dinner tonight", "dinner detail 0"]);

    const forChidi = Object.fromEntries((await topics(chidi)).map((x) => [x.id, [x.messageCount, x.unreadCount]]));
    expect(forChidi).toEqual({ [dinnerTopic]: [6, 6], [wifiTopic]: [1, 1] });
    const forAsha = Object.fromEntries((await topics(asha)).map((x) => [x.id, x.unreadCount]));
    expect(forAsha).toEqual({ [dinnerTopic]: 0, [wifiTopic]: 0 }); // sending marks everything before as read
  });
});

describe("corrections", () => {
  let dinner: { id: string }, wifi: { id: string }, stray: { id: string };
  let dinnerTopic: string, wifiTopic: string;

  beforeEach(async () => {
    dinner = await say(asha, "who is cooking dinner tonight");
    wifi = await say(ben, "the wifi router keeps dropping the connection");
    await settle();
    dinnerTopic = (await topicOf(dinner.id)).topic_id;
    wifiTopic = (await topicOf(wifi.id)).topic_id;
    stray = await say(chidi, "i can make pasta", { topicId: wifiTopic }); // deliberately in the wrong lane
    await settle();
  });

  it("moves a message to another topic for everyone and records the correction", async () => {
    const b = await sock(ben);
    const res = await asha.http.post(`/api/messages/${stray.id}/topic`).send({ topicId: dinnerTopic });
    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([{ messageId: stray.id, topicId: dinnerTopic }]);
    const event = await b.waitFor("lanes:update", (p) => p.assignments.some((a: { messageId: string }) => a.messageId === stray.id));
    expect(event.rev).toBe(res.body.rev);
    expect(await topicOf(stray.id)).toEqual({ topic_id: dinnerTopic, topic_source: "user" });

    const counts = Object.fromEntries((await topics(chidi)).map((x) => [x.id, x.messageCount]));
    expect(counts).toEqual({ [dinnerTopic]: 2, [wifiTopic]: 1 });

    const { rows } = await t.db.query("SELECT kind, user_id, message_id, from_topic_id, to_topic_id, details FROM topic_corrections");
    expect(rows).toEqual([
      { kind: "move", user_id: asha.id, message_id: stray.id, from_topic_id: wifiTopic, to_topic_id: dinnerTopic, details: { previousSource: "lane", previousScore: null, newTopic: false } },
    ]);
    // The move reaches a client that was offline through the normal catch-up path.
    const changes = (await chidi.http.get(`/api/conversations/${groupId}/changes?since=${res.body.rev - 1}`)).body;
    expect(changes.messages.map((m: { id: string; topicId: string }) => [m.id, m.topicId])).toEqual([[stray.id, dinnerTopic]]);
  });

  it("moves a message into a new topic, titled by the member or from the message", async () => {
    const named = await asha.http.post(`/api/messages/${stray.id}/topic`).send({ title: "Pasta night" });
    expect(named.body.topics[0]).toMatchObject({ title: "Pasta night", titleSource: "user", messageCount: 1 });
    const untitled = await asha.http.post(`/api/messages/${dinner.id}/topic`).send({});
    expect(untitled.body.topics[0]).toMatchObject({ title: "Who is cooking dinner tonight", titleSource: "auto" });
    // The dinner topic lost its only message and is gone.
    expect(untitled.body.removed).toEqual([dinnerTopic]);
    expect((await topics()).map((x) => x.id)).not.toContain(dinnerTopic);
  });

  it("merges two topics: every message moves under one rev and the emptied topic disappears", async () => {
    const c = await sock(chidi);
    const res = await ben.http.post(`/api/topics/${wifiTopic}/merge`).send({ intoTopicId: dinnerTopic });
    expect(res.status).toBe(200);
    expect(res.body.removed).toEqual([wifiTopic]);
    expect(res.body.assignments.map((a: { messageId: string }) => a.messageId).sort()).toEqual([wifi.id, stray.id].sort());
    await c.waitFor("lanes:update", (p) => p.removed.includes(wifiTopic));

    const all = await topics();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: dinnerTopic, messageCount: 3 });
    const { rows } = await t.db.query("SELECT DISTINCT rev FROM messages WHERE id = ANY($1)", [[wifi.id, stray.id]]);
    expect(rows).toEqual([{ rev: res.body.rev }]);
    const log = await t.db.query("SELECT kind, from_topic_id, to_topic_id, details->>'messages' AS n FROM topic_corrections");
    expect(log.rows).toEqual([{ kind: "merge", from_topic_id: wifiTopic, to_topic_id: dinnerTopic, n: "2" }]);
  });

  it("renames a topic for everyone, and an automatic title never overwrites a member's", async () => {
    const b = await sock(ben);
    const res = await chidi.http.patch(`/api/topics/${dinnerTopic}`).send({ title: "  Dinner rota  " });
    expect(res.body.topics[0]).toMatchObject({ id: dinnerTopic, title: "Dinner rota", titleSource: "user" });
    const event = await b.waitFor("lanes:update", (p) => p.topics[0]?.title === "Dinner rota");
    expect(event.rev).toBeNull();
    await say(asha, "more about dinner", { topicId: dinnerTopic });
    await settle();
    expect((await topics()).find((x) => x.id === dinnerTopic).title).toBe("Dinner rota");
    const log = await t.db.query("SELECT kind, details FROM topic_corrections");
    expect(log.rows).toEqual([{ kind: "rename", details: { from: "Who is cooking dinner tonight", to: "Dinner rota" } }]);
  });

  it("rejects invalid corrections", async () => {
    expect((await asha.http.post(`/api/messages/${stray.id}/topic`).send({ topicId: randomUUID() })).status).toBe(400);
    expect((await asha.http.post(`/api/topics/${dinnerTopic}/merge`).send({ intoTopicId: dinnerTopic })).status).toBe(400);
    expect((await asha.http.post(`/api/topics/${dinnerTopic}/merge`).send({ intoTopicId: randomUUID() })).status).toBe(400);
    expect((await asha.http.patch(`/api/topics/${dinnerTopic}`).send({ title: "   " })).status).toBe(400);
    expect((await asha.http.patch(`/api/topics/${dinnerTopic}`).send({ title: "x".repeat(81) })).status).toBe(400);
    const id = await dm(asha, ben);
    const m = (await send(asha, id, "dm message")).body.message;
    expect((await asha.http.post(`/api/messages/${m.id}/topic`).send({})).status).toBe(400);
  });

  it("is closed to non-members: 404 for every lane read and correction", async () => {
    const attempts = await Promise.all([
      mallory.http.get(`/api/conversations/${groupId}/topics`),
      mallory.http.get(`/api/conversations/${groupId}/messages?topicId=${dinnerTopic}`),
      mallory.http.post(`/api/messages/${stray.id}/topic`).send({ topicId: dinnerTopic }),
      mallory.http.post(`/api/messages/${stray.id}/topic`).send({ title: "Mine" }),
      mallory.http.post(`/api/topics/${wifiTopic}/merge`).send({ intoTopicId: dinnerTopic }),
      mallory.http.patch(`/api/topics/${dinnerTopic}`).send({ title: "Hacked" }),
    ]);
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect((await topics()).map((x) => [x.id, x.title, x.messageCount]).sort()).toEqual(
      [[dinnerTopic, "Who is cooking dinner tonight", 1], [wifiTopic, "The wifi router keeps dropping the connection", 2]].sort(),
    );
    expect((await t.db.query("SELECT count(*)::int AS n FROM topic_corrections")).rows[0]!.n).toBe(0);
  });
});
