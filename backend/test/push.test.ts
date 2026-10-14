import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PushPayload, PushSender, PushTarget } from "../src/push/service.js";
import { connect, dm, group, resetDb, send, signup, sleep, startApp, type TestApp, type TestSocket, type TestUser } from "./helpers.js";

class FakeSender implements PushSender {
  sent: { endpoint: string; payload: PushPayload }[] = [];
  gone = new Set<string>();
  async send(target: PushTarget, payload: PushPayload): Promise<"sent" | "gone"> {
    if (this.gone.has(target.endpoint)) return "gone";
    this.sent.push({ endpoint: target.endpoint, payload });
    return "sent";
  }
}

let t: TestApp;
const sender = new FakeSender();
let asha: TestUser, ben: TestUser, chidi: TestUser, mallory: TestUser;
let groupId: string;
const open: TestSocket[] = [];

const endpointOf = (user: TestUser, device = "phone") => `https://push.example/${user.username}/${device}`;
const subscribe = (user: TestUser, device = "phone") =>
  user.http.post("/api/push/subscribe").send({ endpoint: endpointOf(user, device), keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } });
const settle = async () => {
  await t.app.ctx.lanes!.idle();
  await sleep(40); // notifications are sent just after the lane job
};
const notified = () => sender.sent.map((s) => s.endpoint.replace("https://push.example/", "")).sort();
const say = async (user: TestUser, text: string, extra: Record<string, unknown> = {}, conversationId = groupId) => {
  const res = await send(user, conversationId, text, extra);
  expect(res.status).toBe(201);
  await settle();
  return res.body.message as { id: string };
};
const topicOf = async (id: string) => (await t.db.query("SELECT topic_id FROM messages WHERE id = $1", [id])).rows[0]!.topic_id as string;

beforeAll(async () => {
  t = await startApp({}, { lanes: true, pushSender: sender });
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const s of open.splice(0)) s.close();
  await settle();
  await resetDb(t.db);
  sender.sent = [];
  sender.gone.clear();
  [asha, ben, chidi, mallory] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi"), signup(t, "mallory")]);
  groupId = await group(asha, "Flat", [ben, chidi]);
  for (const u of [asha, ben, chidi, mallory]) expect((await subscribe(u)).status).toBe(201);
});

describe("who gets a notification", () => {
  it("goes to the other members of the conversation, never the sender or outsiders", async () => {
    const m = await say(asha, "who is cooking dinner tonight");
    expect(notified()).toEqual(["ben/phone", "chidi/phone"]);
    expect(sender.sent[0]!.payload).toEqual({ title: "Asha · Flat", body: "who is cooking dinner tonight", conversationId: groupId, messageId: m.id });
  });

  it("is sent once per message, to every device of a member", async () => {
    await subscribe(ben, "laptop");
    await say(asha, "who is cooking dinner tonight");
    expect(notified()).toEqual(["ben/laptop", "ben/phone", "chidi/phone"]);
  });

  it("uses the sender's name alone for a DM, and names a photo", async () => {
    const id = await dm(asha, ben);
    await say(asha, "see you at nine", {}, id);
    expect(sender.sent.map((s) => [s.endpoint, s.payload.title, s.payload.body])).toEqual([[endpointOf(ben), "Asha", "see you at nine"]]);
  });

  it("skips someone who is looking at SynChat right now", async () => {
    const b = await connect(t, ben.cookie);
    open.push(b);
    b.socket.emit("looking", true);
    await sleep(50);
    await say(asha, "ben is watching this arrive");
    expect(notified()).toEqual(["chidi/phone"]);
    b.socket.emit("looking", false); // tab in the background
    await sleep(50);
    await say(asha, "now he is not");
    expect(notified()).toContain("ben/phone");
  });
});

describe("topic mute", () => {
  let wifiTopic: string;
  beforeEach(async () => {
    await say(asha, "who is cooking dinner tonight");
    wifiTopic = await topicOf((await say(asha, "the wifi router keeps dropping the connection")).id);
    await ben.http.put(`/api/topics/${wifiTopic}/mute`).send({ muted: true });
    sender.sent = [];
  });

  it("silences notifications from a muted topic, for the member who muted it only", async () => {
    await say(asha, "wifi is still down", { topicId: wifiTopic });
    expect(notified()).toEqual(["chidi/phone"]);
  });

  it("applies to messages the assigner places in the muted topic, not just pinned ones", async () => {
    const m = await say(chidi, "restart the wifi router and check the connection again");
    expect(await topicOf(m.id)).toBe(wifiTopic); // placed there by the assigner, after sending
    expect(notified()).toEqual(["asha/phone"]);
  });

  it("lets a direct mention through", async () => {
    await say(asha, "@ben can you restart the wifi router", { topicId: wifiTopic });
    expect(notified()).toEqual(["ben/phone", "chidi/phone"]);
  });

  it("is ignored once the member switches topic mute off, and other topics were never affected", async () => {
    await say(asha, "pasta tonight?", { replyToId: (await t.db.query("SELECT id FROM messages WHERE text LIKE 'who is cooking%'")).rows[0]!.id });
    expect(notified()).toEqual(["ben/phone", "chidi/phone"]);
    sender.sent = [];
    await ben.http.patch("/api/auth/smart").send({ topicMute: false });
    await say(asha, "wifi is back", { topicId: wifiTopic });
    expect(notified()).toEqual(["ben/phone", "chidi/phone"]);
  });
});

describe("subscriptions", () => {
  it("stop when the browser's login ends", async () => {
    await ben.http.post("/api/auth/logout");
    await say(asha, "who is cooking dinner tonight");
    expect(notified()).toEqual(["chidi/phone"]);
  });

  it("can be turned off, by their owner only", async () => {
    await mallory.http.post("/api/push/unsubscribe").send({ endpoint: endpointOf(ben) });
    await say(asha, "one");
    expect(notified()).toContain("ben/phone");
    sender.sent = [];
    await ben.http.post("/api/push/unsubscribe").send({ endpoint: endpointOf(ben) });
    await say(asha, "two");
    expect(notified()).toEqual(["chidi/phone"]);
  });

  it("are removed when the push service says the browser is gone", async () => {
    sender.gone.add(endpointOf(ben));
    await say(asha, "one");
    expect((await t.db.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [ben.id])).rows[0]!.n).toBe(0);
  });

  it("move to whoever is signed in on that browser now", async () => {
    await mallory.http.post("/api/push/subscribe").send({ endpoint: endpointOf(ben), keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } });
    await say(asha, "for the flat only");
    expect(notified()).toEqual(["chidi/phone"]); // mallory is not in the group; ben's browser is no longer his
  });

  it("stop for someone removed from the group", async () => {
    await asha.http.delete(`/api/conversations/${groupId}/members/${chidi.id}`);
    await say(asha, "after chidi left");
    expect(notified()).toEqual(["ben/phone"]);
  });

  it("need a session and a real push endpoint", async () => {
    expect((await fetch(`${t.url}/api/push/subscribe`, { method: "POST" })).status).toBe(401);
    for (const endpoint of ["http://push.example/x", "https://", "not a url", "file:///etc/passwd", "javascript:alert(1)"]) {
      const res = await asha.http.post("/api/push/subscribe").send({ endpoint, keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } });
      expect(res.status, endpoint).toBe(400);
    }
    expect((await asha.http.post("/api/push/subscribe").send({ endpoint: "https://push.example/x" })).status).toBe(400);
  });

  it("are unavailable on a server without push keys", async () => {
    const plain = await startApp();
    try {
      const cfg = (await (await fetch(`${plain.url}/api/config`)).json()) as { features: { push: boolean }; vapidPublicKey: string | null };
      expect(cfg).toMatchObject({ features: { push: false }, vapidPublicKey: null });
      await resetDb(plain.db);
      const user = await signup(plain, "dora");
      expect((await user.http.post("/api/push/subscribe").send({ endpoint: "https://push.example/d", keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } })).status).toBe(503);
    } finally {
      await plain.close();
    }
  });
});
