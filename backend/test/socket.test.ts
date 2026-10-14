import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, dm, group, resetDb, send, signup, sleep, startApp, type TestApp, type TestSocket, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, chidi: TestUser;
let groupId: string;
const open: TestSocket[] = [];
const sock = async (...args: Parameters<typeof connect>) => {
  const s = await connect(...args);
  open.push(s);
  return s;
};

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const s of open.splice(0)) s.close();
  await sleep(120); // let presence timers from the previous test settle
  await resetDb(t.db);
  [asha, ben, chidi] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi")]);
  groupId = await group(asha, "Trip", [ben]);
});

describe("socket authentication", () => {
  it("refuses a connection with no session cookie", async () => {
    await expect(connect(t)).rejects.toThrow(/unauthorized/);
  });

  it("ignores a userId in the query string (the original impersonation hole)", async () => {
    await expect(connect(t, undefined, { query: { userId: ben.id } })).rejects.toThrow(/unauthorized/);
    // A real session plus someone else's id in the query is still only that session's user.
    const c = await sock(t, chidi.cookie, { query: { userId: ben.id } });
    await send(asha, groupId, "for the group only");
    await sleep(150);
    expect(c.events.filter((e) => e.event === "message:new")).toEqual([]);
  });

  it("refuses a forged or expired cookie", async () => {
    await expect(connect(t, "sid=forged")).rejects.toThrow(/unauthorized/);
    await t.db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [ben.id]);
    await expect(connect(t, ben.cookie)).rejects.toThrow(/unauthorized/);
  });

  it("refuses a handshake from another origin", async () => {
    const res = await fetch(`${t.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: "https://evil.example", cookie: ben.cookie },
    });
    expect(res.status).toBe(403);
  });

  it("drops the socket when its session logs out", async () => {
    const b = await sock(t, ben.cookie);
    const closed = new Promise((resolve) => b.socket.once("disconnect", resolve));
    await ben.http.post("/api/auth/logout");
    await expect(closed).resolves.toBeDefined();
  });
});

describe("delivery", () => {
  it("delivers a new message to every member's devices, including the sender's others", async () => {
    const [b1, b2, a2] = await Promise.all([sock(t, ben.cookie), sock(t, ben.cookie), sock(t, asha.cookie)]);
    const sent = (await send(asha, groupId, "hello trip")).body.message;
    for (const s of [b1, b2, a2]) {
      const got = await s.waitFor("message:new");
      expect(got.message).toEqual(sent);
    }
  });

  it("delivers messages for chats that are not open, so the sidebar can update", async () => {
    const b = await sock(t, ben.cookie);
    const other = await dm(chidi, ben);
    const created = await b.waitFor("conversation:updated", (p) => p.conversation.id === other);
    expect(created.conversation.type).toBe("dm");
    await send(chidi, other, "ping");
    await send(asha, groupId, "pong");
    await b.waitFor("message:new", (p) => p.message.text === "pong");
    expect(b.events.filter((e) => e.event === "message:new").map((e) => e.payload.message.conversationId).sort()).toEqual([other, groupId].sort());
  });

  it("does not deliver a retried message twice", async () => {
    const b = await sock(t, ben.cookie);
    const id = crypto.randomUUID();
    await asha.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "once" });
    await asha.http.post(`/api/conversations/${groupId}/messages`).send({ id, text: "once" });
    await send(asha, groupId, "after");
    await b.waitFor("message:new", (p) => p.message.text === "after");
    expect(b.events.filter((e) => e.event === "message:new").map((e) => e.payload.message.text)).toEqual(["once", "after"]);
  });

  it("delivers in sequence order", async () => {
    const b = await sock(t, ben.cookie);
    for (let i = 1; i <= 15; i++) await send(asha, groupId, `m${i}`);
    await b.waitFor("message:new", (p) => p.message.seq === 15);
    expect(b.events.filter((e) => e.event === "message:new").map((e) => e.payload.message.seq)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
  });
});

describe("reconnect", () => {
  it("lets a client fetch exactly what it missed while disconnected", async () => {
    const b = await sock(t, ben.cookie);
    await send(asha, groupId, "seen live");
    const live = await b.waitFor("message:new");
    const cursor = live.message.rev;
    b.close();

    for (const text of ["missed 1", "missed 2", "missed 3"]) await send(asha, groupId, text);

    const again = await sock(t, ben.cookie);
    const changes = (await ben.http.get(`/api/conversations/${groupId}/changes?since=${cursor}`)).body;
    expect(changes.messages.map((m: { text: string }) => m.text)).toEqual(["missed 1", "missed 2", "missed 3"]);

    // Live delivery resumes exactly where the catch-up ended: no gap, no overlap.
    await send(asha, groupId, "live again");
    const next = await again.waitFor("message:new");
    expect(next.message.rev).toBe(changes.rev + 1);
    expect(next.message.seq).toBe(changes.messages.at(-1).seq + 1);
  });
});

describe("presence with several devices", () => {
  const presenceOf = (s: TestSocket, userId: string) =>
    s.events.filter((e) => e.event === "presence" && e.payload.userId === userId).map((e) => e.payload.online);

  it("announces online once and offline only when the last device leaves", async () => {
    const a = await sock(t, asha.cookie);
    const b1 = await sock(t, ben.cookie);
    await a.waitFor("presence", (p) => p.userId === ben.id && p.online);
    const b2 = await sock(t, ben.cookie);
    await sleep(100);
    expect(presenceOf(a, ben.id)).toEqual([true]);

    b1.close();
    await sleep(200);
    expect(presenceOf(a, ben.id)).toEqual([true]); // still on the second device

    b2.close();
    await a.waitFor("presence", (p) => p.userId === ben.id && !p.online);
    expect(presenceOf(a, ben.id)).toEqual([true, false]);
  });

  it("tells only people who share a conversation with the user", async () => {
    const [a, c] = await Promise.all([sock(t, asha.cookie), sock(t, chidi.cookie)]);
    await sock(t, ben.cookie);
    await a.waitFor("presence", (p) => p.userId === ben.id);
    await sleep(100);
    expect(presenceOf(c, ben.id)).toEqual([]);
    const snapshot = await new Promise<{ online: string[] }>((resolve) => c.socket.emit("presence:sync", resolve));
    expect(snapshot.online).toEqual([]);
    const forAsha = await new Promise<{ online: string[] }>((resolve) => a.socket.emit("presence:sync", resolve));
    expect(forAsha.online).toEqual([ben.id]);
  });
});

describe("typing", () => {
  it("is relayed to the other members only", async () => {
    const [a, b, c] = await Promise.all([sock(t, asha.cookie), sock(t, ben.cookie), sock(t, chidi.cookie)]);
    a.socket.emit("typing", { conversationId: groupId });
    expect(await b.waitFor("typing")).toEqual({ conversationId: groupId, userId: asha.id });
    await sleep(100);
    expect(a.events.some((e) => e.event === "typing")).toBe(false);
    expect(c.events.some((e) => e.event === "typing")).toBe(false);
  });
});
