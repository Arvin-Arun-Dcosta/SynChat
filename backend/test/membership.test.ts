import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, dm, group, resetDb, send, signup, sleep, startApp, type TestApp, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, mallory: TestUser;
let dmId: string, groupId: string, messageId: string;

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDb(t.db);
  [asha, ben, mallory] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "mallory")]);
  dmId = await dm(asha, ben);
  groupId = await group(asha, "Flat", [ben]);
  messageId = (await send(asha, groupId, "rent is due friday")).body.message.id;
  await send(ben, dmId, "private hello");
});

describe("a non-member", () => {
  it("does not see other people's conversations in their list", async () => {
    const res = await mallory.http.get("/api/conversations");
    expect(res.body.conversations).toEqual([]);
  });

  it.each(["dm", "group"])("gets 404 from every read of a %s it is not in", async (kind) => {
    const id = kind === "dm" ? dmId : groupId;
    for (const path of [`/api/conversations/${id}`, `/api/conversations/${id}/messages`, `/api/conversations/${id}/changes?since=0`]) {
      const res = await mallory.http.get(path);
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/rent|hello/);
    }
  });

  it.each(["dm", "group"])("gets 404 from every write to a %s it is not in", async (kind) => {
    const id = kind === "dm" ? dmId : groupId;
    expect((await send(mallory, id, "let me in")).status).toBe(404);
    expect((await mallory.http.post(`/api/conversations/${id}/read`).send({ seq: 1 })).status).toBe(404);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM messages WHERE sender_id = $1", [mallory.id]);
    expect(rows[0]!.n).toBe(0);
  });

  it("gets the same 404 for a real conversation as for one that does not exist", async () => {
    const real = await mallory.http.get(`/api/conversations/${groupId}/messages`);
    const fake = await mallory.http.get(`/api/conversations/${randomUUID()}/messages`);
    expect(real.status).toBe(404);
    expect(real.body).toEqual(fake.body);
  });

  it("cannot reply to a message from a conversation it is not in", async () => {
    const own = await dm(mallory, asha);
    const res = await send(mallory, own, "quoting you", { replyToId: messageId });
    expect(res.status).toBe(400);
  });

  it("cannot reuse another conversation's message id to probe or overwrite it", async () => {
    const own = await dm(mallory, asha);
    const res = await mallory.http.post(`/api/conversations/${own}/messages`).send({ id: messageId, text: "overwrite" });
    expect(res.status).toBe(409);
    const { rows } = await t.db.query("SELECT text, sender_id FROM messages WHERE id = $1", [messageId]);
    expect(rows[0]!).toEqual({ text: "rent is due friday", sender_id: asha.id });
  });

  it("cannot open a DM by raw user id with someone it shares nothing with", async () => {
    const res = await mallory.http.post("/api/conversations/dm").send({ userId: ben.id });
    expect(res.status).toBe(404);
    // ...but a member of a shared group can.
    expect((await asha.http.post("/api/conversations/dm").send({ userId: ben.id })).status).toBe(200);
  });

  it("receives nothing over the socket for conversations it is not in", async () => {
    const [m, b] = await Promise.all([connect(t, mallory.cookie), connect(t, ben.cookie)]);
    try {
      await send(asha, groupId, "members only");
      await send(asha, dmId, "for ben only");
      await b.waitFor("message:new", (p) => p.message.text === "for ben only");
      m.socket.emit("typing", { conversationId: groupId });
      await sleep(150);
      expect(m.events.filter((e) => e.event !== "presence")).toEqual([]);
      expect(b.events.some((e) => e.event === "typing")).toBe(false);
    } finally {
      m.close();
      b.close();
    }
  });
});

describe("a member", () => {
  it("sees each conversation from their own point of view", async () => {
    const forBen = (await ben.http.get("/api/conversations")).body.conversations;
    expect(forBen.map((c: { type: string }) => c.type).sort()).toEqual(["dm", "group"]);
    const flat = forBen.find((c: { type: string }) => c.type === "group");
    expect(flat).toMatchObject({ name: "Flat", myRole: "member", unreadCount: 1 });
    expect(flat.members.map((m: { username: string }) => m.username).sort()).toEqual(["asha", "ben"]);
    expect(JSON.stringify(forBen)).not.toMatch(/email|password/);
    const forAsha = (await asha.http.get(`/api/conversations/${groupId}`)).body.conversation;
    expect(forAsha).toMatchObject({ myRole: "admin", unreadCount: 0 });
  });

  it("reuses the one DM between two people, whoever opens it", async () => {
    expect(await dm(ben, asha)).toBe(dmId);
    const both = await Promise.all([dm(asha, mallory), dm(mallory, asha), dm(asha, mallory)]);
    expect(new Set(both).size).toBe(1);
  });

  it("cannot DM themselves", async () => {
    expect((await asha.http.post("/api/conversations/dm").send({ username: "asha" })).status).toBe(400);
  });
});
