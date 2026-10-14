import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PNG, connect, dm, group, resetDb, send, signup, startApp, uploadImage, type TestApp, type TestSocket, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, chidi: TestUser, mallory: TestUser;
let groupId: string;
let msg: { id: string; rev: number };
const open: TestSocket[] = [];
const sock = async (user: TestUser) => {
  const s = await connect(t, user.cookie);
  open.push(s);
  return s;
};

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const s of open.splice(0)) s.close();
  await resetDb(t.db);
  [asha, ben, chidi, mallory] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi"), signup(t, "mallory")]);
  groupId = await group(asha, "Trip", [ben, chidi]);
  msg = (await send(ben, groupId, "shall we book the 9am train?")).body.message;
});

const fetchMessage = async (user: TestUser, id: string) =>
  (await user.http.get(`/api/conversations/${groupId}/messages`)).body.messages.find((m: { id: string }) => m.id === id);

describe("reactions", () => {
  it("adds and removes a reaction, grouped by emoji", async () => {
    await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "👍" });
    await chidi.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "👍" });
    const res = await chidi.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "🚆" });
    expect(res.body.message.reactions).toEqual([
      { emoji: "👍", userIds: [asha.id, chidi.id] },
      { emoji: "🚆", userIds: [chidi.id] },
    ]);
    const after = await asha.http.delete(`/api/messages/${msg.id}/reactions`).send({ emoji: "👍" });
    expect(after.body.message.reactions[0]).toEqual({ emoji: "👍", userIds: [chidi.id] });
  });

  it("is idempotent and only spends a rev when something changed", async () => {
    const first = await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "❤️" });
    const again = await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "❤️" });
    expect(first.body.message.rev).toBe(msg.rev + 1);
    expect(again.body.message.rev).toBe(first.body.message.rev);
    expect(again.body.message.reactions).toEqual([{ emoji: "❤️", userIds: [asha.id] }]);
  });

  it("accepts compound emoji and rejects anything that is not one", async () => {
    for (const emoji of ["👍🏽", "👨‍👩‍👧", "🇮🇳"]) {
      expect((await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji })).status, emoji).toBe(200);
    }
    for (const emoji of ["lol", "<b>", "", "👍 text", "a".repeat(40)]) {
      expect((await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji })).status, emoji).toBe(400);
    }
  });

  it("reaches other members live and through catch-up", async () => {
    const b = await sock(ben);
    await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "👍" });
    const event = await b.waitFor("message:updated");
    expect(event.message.reactions).toEqual([{ emoji: "👍", userIds: [asha.id] }]);
    const changes = (await chidi.http.get(`/api/conversations/${groupId}/changes?since=${msg.rev}`)).body;
    expect(changes.messages).toHaveLength(1);
    expect(changes.messages[0].reactions).toHaveLength(1);
  });
});

describe("editing", () => {
  it("lets the sender edit, marks it edited, and tells everyone", async () => {
    const a = await sock(asha);
    const res = await ben.http.patch(`/api/messages/${msg.id}`).send({ text: "shall we book the 10am train?" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ text: "shall we book the 10am train?", rev: msg.rev + 1, seq: 1 });
    expect(res.body.message.editedAt).not.toBeNull();
    expect((await a.waitFor("message:updated")).message.text).toBe("shall we book the 10am train?");
  });

  it("refuses edits by anyone else, including a group admin", async () => {
    expect((await asha.http.patch(`/api/messages/${msg.id}`).send({ text: "hijacked" })).status).toBe(403);
    expect((await fetchMessage(ben, msg.id)).text).toBe("shall we book the 9am train?");
  });

  it("refuses an empty or oversized edit", async () => {
    expect((await ben.http.patch(`/api/messages/${msg.id}`).send({ text: "  " })).status).toBe(400);
    expect((await ben.http.patch(`/api/messages/${msg.id}`).send({ text: "x".repeat(4001) })).status).toBe(400);
  });
});

describe("deleting", () => {
  it("erases the content for everyone but keeps the message's place", async () => {
    const image = await uploadImage(ben);
    const withImage = (await send(ben, groupId, "look", { imageId: image.id })).body.message;
    await asha.http.put(`/api/messages/${withImage.id}/reactions`).send({ emoji: "👍" });
    const res = await ben.http.delete(`/api/messages/${withImage.id}`);
    expect(res.body.message).toMatchObject({ deleted: true, text: null, image: null, reactions: [], seq: 2 });
    const { rows } = await t.db.query("SELECT text, image_url FROM messages WHERE id = $1", [withImage.id]);
    expect(rows[0]).toEqual({ text: null, image_url: null });
  });

  it("lets a group admin delete someone else's message, but not an ordinary member", async () => {
    expect((await chidi.http.delete(`/api/messages/${msg.id}`)).status).toBe(403);
    expect((await asha.http.delete(`/api/messages/${msg.id}`)).status).toBe(200);
  });

  it("does not let either side of a DM delete the other's message", async () => {
    const id = await dm(asha, ben);
    const theirs = (await send(ben, id, "mine")).body.message;
    expect((await asha.http.delete(`/api/messages/${theirs.id}`)).status).toBe(403);
  });

  it("refuses edits and reactions on a deleted message", async () => {
    await ben.http.delete(`/api/messages/${msg.id}`);
    expect((await ben.http.patch(`/api/messages/${msg.id}`).send({ text: "back" })).status).toBe(409);
    expect((await asha.http.put(`/api/messages/${msg.id}/reactions`).send({ emoji: "👍" })).status).toBe(409);
  });
});

describe("replies", () => {
  it("carries a preview of the message replied to, which follows edits and deletes", async () => {
    const reply = (await send(asha, groupId, "9am is too early", { replyToId: msg.id })).body.message;
    expect(reply.replyTo).toEqual({ id: msg.id, senderId: ben.id, text: "shall we book the 9am train?", hasImage: false, deleted: false });
    await ben.http.delete(`/api/messages/${msg.id}`);
    expect((await fetchMessage(chidi, reply.id)).replyTo).toMatchObject({ text: null, deleted: true });
  });
});

describe("read receipts", () => {
  it("broadcasts each member's read position to the conversation", async () => {
    const b = await sock(ben);
    await chidi.http.post(`/api/conversations/${groupId}/read`).send({ seq: 1 });
    expect(await b.waitFor("read")).toEqual({ conversationId: groupId, userId: chidi.id, lastReadSeq: 1 });
    const members = (await ben.http.get(`/api/conversations/${groupId}`)).body.conversation.members;
    expect(Object.fromEntries(members.map((m: { username: string; lastReadSeq: number }) => [m.username, m.lastReadSeq]))).toEqual({ asha: 0, ben: 1, chidi: 1 });
  });
});

describe("images", () => {
  it("attaches an uploaded image to a message", async () => {
    const res = await asha.http.post("/api/uploads/image").field("width", "640").field("height", "480").attach("image", PNG, "pic.png");
    expect(res.status).toBe(201);
    const sent = await send(asha, groupId, "", { imageId: res.body.upload.id });
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ text: null, image: { url: res.body.upload.url, width: 640, height: 480 } });
    const served = await asha.http.get(res.body.upload.url);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("decides the type from the bytes, not the filename or content type", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>".padEnd(64));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'.padEnd(64));
    for (const [buf, name, type] of [[html, "evil.png", "image/png"], [svg, "x.svg", "image/svg+xml"], [Buffer.alloc(0), "empty.png", "image/png"]] as const) {
      const res = await asha.http.post("/api/uploads/image").attach("image", buf, { filename: name, contentType: type });
      expect(res.status, name).toBe(400);
    }
    // A real PNG named .html is stored as .png.
    const ok = await asha.http.post("/api/uploads/image").attach("image", PNG, { filename: "../../x.html", contentType: "text/html" });
    expect(ok.body.upload.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
  });

  it("rejects files over 5 MB with 413", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await asha.http.post("/api/uploads/image").attach("image", big, "big.png")).status).toBe(413);
  });

  it("only attaches an image the sender uploaded themselves", async () => {
    const theirs = await uploadImage(ben);
    const res = await send(asha, groupId, "stolen", { imageId: theirs.id });
    expect(res.status).toBe(400);
    expect((await send(asha, groupId, "made up", { imageId: randomUUID() })).status).toBe(400);
  });

  it("has no way to send an arbitrary image URL", async () => {
    const res = await asha.http
      .post(`/api/conversations/${groupId}/messages`)
      .send({ id: randomUUID(), text: "hi", imageUrl: "https://tracker.example/pixel.gif", image: { url: "https://tracker.example/p.gif" } });
    expect(res.body.message.image).toBeNull();
  });

  it("requires a session to upload", async () => {
    const res = await fetch(`${t.url}/api/uploads/image`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("reports image upload as unavailable when nothing is configured in production", async () => {
    const prod = await startApp({ isProd: true, cloudinary: null });
    try {
      const cfg = (await (await fetch(`${prod.url}/api/config`)).json()) as { features: { imageUpload: boolean } };
      expect(cfg.features.imageUpload).toBe(false);
      const user = await signup(prod, "dora");
      expect((await user.http.post("/api/uploads/image").attach("image", PNG, "p.png")).status).toBe(503);
    } finally {
      await prod.close();
    }
  });
});

describe("a non-member acting on a message by id", () => {
  it("gets 404 for every action, same as for a message that does not exist", async () => {
    const attempts = (id: string) => [
      mallory.http.patch(`/api/messages/${id}`).send({ text: "edited by a stranger" }),
      mallory.http.delete(`/api/messages/${id}`),
      mallory.http.put(`/api/messages/${id}/reactions`).send({ emoji: "👍" }),
      mallory.http.delete(`/api/messages/${id}/reactions`).send({ emoji: "👍" }),
    ];
    const real = await Promise.all(attempts(msg.id));
    const fake = await Promise.all(attempts(randomUUID()));
    expect(real.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(real.map((r) => r.body)).toEqual(fake.map((r) => r.body));
    expect(await fetchMessage(ben, msg.id)).toMatchObject({ text: "shall we book the 9am train?", deleted: false, reactions: [] });
  });
});
