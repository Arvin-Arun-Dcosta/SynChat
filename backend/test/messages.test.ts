import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dm, group, resetDb, send, signup, startApp, type TestApp, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, chidi: TestUser;
let groupId: string;

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDb(t.db);
  [asha, ben, chidi] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi")]);
  groupId = await group(asha, "Trip", [ben, chidi]);
});

const history = async (user: TestUser, id: string, query = "") =>
  (await user.http.get(`/api/conversations/${id}/messages${query}`)).body;

describe("ordering", () => {
  it("numbers messages 1, 2, 3... per conversation in the order they were stored", async () => {
    for (const text of ["one", "two", "three"]) await send(asha, groupId, text);
    const other = await dm(asha, ben);
    await send(ben, other, "separate counter");
    const page = await history(asha, groupId);
    expect(page.messages.map((m: { seq: number; text: string }) => [m.seq, m.text])).toEqual([[1, "one"], [2, "two"], [3, "three"]]);
    expect((await history(ben, other)).messages[0].seq).toBe(1);
  });

  it("gives concurrent sends unique, gap-free sequence numbers", async () => {
    const senders = [asha, ben, chidi];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => send(senders[i % 3]!, groupId, `m${i}`)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => r.body.message.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const revs = results.map((r) => r.body.message.rev).sort((a, b) => a - b);
    expect(new Set(revs).size).toBe(30);
    const { rows } = await t.db.query("SELECT last_seq, rev FROM conversations WHERE id = $1", [groupId]);
    expect(rows[0]!).toEqual({ last_seq: 30, rev: 30 });
  });

  it("pages backwards through history without gaps or repeats", async () => {
    for (let i = 1; i <= 25; i++) await send(asha, groupId, `m${i}`);
    const newest = await history(ben, groupId, "?limit=10");
    expect(newest.messages.map((m: { seq: number }) => m.seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(newest.hasMore).toBe(true);
    const middle = await history(ben, groupId, "?limit=10&before=16");
    expect(middle.messages.map((m: { seq: number }) => m.seq)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const oldest = await history(ben, groupId, "?limit=10&before=6");
    expect(oldest.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(oldest.hasMore).toBe(false);
  });
});

describe("idempotent sends", () => {
  it("stores a retried message once and returns the original", async () => {
    const id = randomUUID();
    const first = await asha.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "hello" });
    const retry = await asha.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "hello" });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.message).toEqual(first.body.message);
    expect((await history(asha, groupId)).messages).toHaveLength(1);
  });

  it("stores a message once even when the retries race each other", async () => {
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => asha.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "once" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    const { rows } = await t.db.query("SELECT count(*)::int AS n, max(seq) AS top FROM messages WHERE conversation_id = $1", [groupId]);
    expect(rows[0]!).toEqual({ n: 1, top: 1 });
  });

  it("refuses an id that another member already used", async () => {
    const id = randomUUID();
    await asha.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "mine" });
    const res = await ben.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "also mine?" });
    expect(res.status).toBe(409);
  });
});

describe("catching up after being away", () => {
  it("returns exactly the messages created since the client's rev", async () => {
    await send(asha, groupId, "before 1");
    await send(asha, groupId, "before 2");
    const seen = await history(ben, groupId);
    expect(seen.rev).toBe(2);

    for (const text of ["missed 1", "missed 2", "missed 3"]) await send(chidi, groupId, text);

    const changes = (await ben.http.get(`/api/conversations/${groupId}/changes?since=${seen.rev}`)).body;
    expect(changes.reset).toBe(false);
    expect(changes.rev).toBe(5);
    expect(changes.messages.map((m: { text: string }) => m.text)).toEqual(["missed 1", "missed 2", "missed 3"]);

    const nothing = (await ben.http.get(`/api/conversations/${groupId}/changes?since=${changes.rev}`)).body;
    expect(nothing.messages).toEqual([]);
  });

  it("tells the client to reload instead when too much has changed", async () => {
    await t.db.query(
      `INSERT INTO messages (id, conversation_id, seq, rev, sender_id, text)
       SELECT gen_random_uuid(), $1, g, g, $2, 'bulk ' || g FROM generate_series(1, 501) g`,
      [groupId, asha.id],
    );
    await t.db.query("UPDATE conversations SET last_seq = 501, rev = 501 WHERE id = $1", [groupId]);
    const changes = (await ben.http.get(`/api/conversations/${groupId}/changes?since=0`)).body;
    expect(changes).toEqual({ messages: [], rev: 501, reset: true });
    const partial = (await ben.http.get(`/api/conversations/${groupId}/changes?since=400`)).body;
    expect(partial.messages).toHaveLength(101);
  });
});

describe("unread counts", () => {
  const unread = async (user: TestUser) =>
    (await user.http.get(`/api/conversations/${groupId}`)).body.conversation.unreadCount;

  it("counts other people's messages after my read position", async () => {
    await send(asha, groupId, "one");
    await send(ben, groupId, "two");
    await send(asha, groupId, "three");
    expect(await unread(chidi)).toBe(3);
    expect(await unread(ben)).toBe(1); // sending marked "one" and "two" read
    expect(await unread(asha)).toBe(0);

    await chidi.http.post(`/api/conversations/${groupId}/read`).send({ seq: 2 });
    expect(await unread(chidi)).toBe(1);
  });

  it("never moves a read position backwards or past the last message", async () => {
    for (const text of ["one", "two", "three"]) await send(asha, groupId, text);
    await ben.http.post(`/api/conversations/${groupId}/read`).send({ seq: 3 });
    await ben.http.post(`/api/conversations/${groupId}/read`).send({ seq: 1 });
    await ben.http.post(`/api/conversations/${groupId}/read`).send({ seq: 999 });
    const { rows } = await t.db.query("SELECT last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [groupId, ben.id]);
    expect(rows[0]!.last_read_seq).toBe(3);
  });
});

describe("input validation", () => {
  it.each([
    ["empty text", { id: randomUUID(), text: "   " }],
    ["no text", { id: randomUUID() }],
    ["text over the limit", { id: randomUUID(), text: "x".repeat(4001) }],
    ["a missing id", { text: "hi" }],
    ["a non-uuid id", { id: "1", text: "hi" }],
    ["a non-string text", { id: randomUUID(), text: { $ne: null } }],
  ])("rejects %s", async (_label, body) => {
    const res = await asha.http.post(`/api/conversations/${groupId}/messages`).send(body);
    expect(res.status).toBe(400);
  });

  it("rejects malformed ids and cursors in the URL", async () => {
    expect((await asha.http.get("/api/conversations/not-a-uuid/messages")).status).toBe(400);
    expect((await asha.http.get(`/api/conversations/${groupId}/messages?limit=5000`)).status).toBe(400);
    expect((await asha.http.get(`/api/conversations/${groupId}/changes`)).status).toBe(400);
    expect((await asha.http.get(`/api/conversations/${groupId}/changes?since=abc`)).status).toBe(400);
  });

  it("stores text exactly as typed, with no interpretation", async () => {
    const text = `<img src=x onerror=alert(1)> '; DROP TABLE messages; -- {{7*7}}`;
    const res = await send(asha, groupId, text);
    expect(res.body.message.text).toBe(text);
    expect((await history(ben, groupId)).messages[0].text).toBe(text);
  });

  it("rate-limits a flood of sends from one user", async () => {
    const limited = await startApp({ rateLimits: true });
    try {
      await resetDb(limited.db);
      const [a, b] = await Promise.all([signup(limited, "asha"), signup(limited, "ben")]);
      const id = await dm(a, b);
      const statuses = [];
      for (let i = 0; i < 33; i++) statuses.push((await send(a, id, `flood ${i}`)).status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(30);
      expect(statuses.slice(30)).toEqual([429, 429, 429]);
      expect((await send(b, id, "not me")).status).toBe(201);
    } finally {
      await limited.close();
    }
  });
});
