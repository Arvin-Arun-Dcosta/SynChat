import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PNG, connect, dm, group, resetDb, send, signup, sleep, startApp, type TestApp, type TestSocket, type TestUser } from "./helpers.js";

let t: TestApp;
let asha: TestUser, ben: TestUser, chidi: TestUser, dora: TestUser;
let groupId: string;
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
  [asha, ben, chidi, dora] = await Promise.all([signup(t, "asha"), signup(t, "ben"), signup(t, "chidi"), signup(t, "dora")]);
  groupId = await group(asha, "Flat", [ben, chidi]);
});

const details = async (user: TestUser) => (await user.http.get(`/api/conversations/${groupId}`)).body.conversation;
const roles = async (user: TestUser) =>
  Object.fromEntries((await details(user)).members.map((m: { username: string; role: string }) => [m.username, m.role]));
const lastTexts = async (user: TestUser) =>
  (await user.http.get(`/api/conversations/${groupId}/messages`)).body.messages.map((m: { text: string }) => m.text);

describe("group administration", () => {
  it("is refused to ordinary members, for every admin action", async () => {
    const invite = (await asha.http.post(`/api/conversations/${groupId}/invites`)).body.invite;
    const attempts = await Promise.all([
      ben.http.patch(`/api/conversations/${groupId}`).send({ name: "Ben's flat" }),
      ben.http.post(`/api/conversations/${groupId}/avatar`).attach("image", PNG, "a.png"),
      ben.http.post(`/api/conversations/${groupId}/members`).send({ username: "dora" }),
      ben.http.delete(`/api/conversations/${groupId}/members/${chidi.id}`),
      ben.http.patch(`/api/conversations/${groupId}/members/${ben.id}`).send({ role: "admin" }),
      ben.http.get(`/api/conversations/${groupId}/invites`),
      ben.http.post(`/api/conversations/${groupId}/invites`),
      ben.http.delete(`/api/conversations/${groupId}/invites/${invite.id}`),
    ]);
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    expect(await details(asha)).toMatchObject({ name: "Flat", avatarUrl: null });
    expect(await roles(asha)).toEqual({ asha: "admin", ben: "member", chidi: "member" });
  });

  it("is refused to non-members with 404", async () => {
    const attempts = await Promise.all([
      dora.http.patch(`/api/conversations/${groupId}`).send({ name: "Mine now" }),
      dora.http.post(`/api/conversations/${groupId}/avatar`).attach("image", PNG, "a.png"),
      dora.http.post(`/api/conversations/${groupId}/members`).send({ username: "dora" }),
      dora.http.delete(`/api/conversations/${groupId}/members/${ben.id}`),
      dora.http.patch(`/api/conversations/${groupId}/members/${dora.id}`).send({ role: "admin" }),
      dora.http.get(`/api/conversations/${groupId}/invites`),
      dora.http.post(`/api/conversations/${groupId}/invites`),
    ]);
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
  });

  it("renames the group, sets its photo, and records both in the chat", async () => {
    const b = await sock(ben);
    await asha.http.patch(`/api/conversations/${groupId}`).send({ name: "Flat 4B" });
    const res = await asha.http.post(`/api/conversations/${groupId}/avatar`).attach("image", PNG, "a.png");
    expect(res.body.conversation.avatarUrl).toMatch(/^\/uploads\//);
    await b.waitFor("conversation:updated", (p) => p.conversation.avatarUrl !== null);
    expect(await lastTexts(ben)).toEqual(['Asha renamed the group to "Flat 4B"', "Asha changed the group photo"]);
    expect((await details(ben)).name).toBe("Flat 4B");
  });

  it("adds a member, who then sees the history and gets live messages", async () => {
    await send(asha, groupId, "before dora");
    const d = await sock(dora);
    const res = await asha.http.post(`/api/conversations/${groupId}/members`).send({ username: "dora" });
    expect(res.status).toBe(200);
    const pushed = await d.waitFor("conversation:updated");
    expect(pushed.conversation).toMatchObject({ id: groupId, myRole: "member", unreadCount: 0 });
    expect(await lastTexts(dora)).toEqual(["before dora", "Asha added Dora"]);
    await send(ben, groupId, "welcome dora");
    await d.waitFor("message:new", (p) => p.message.text === "welcome dora");
  });

  it("does not reveal whether a username exists to a non-admin", async () => {
    const exists = await ben.http.post(`/api/conversations/${groupId}/members`).send({ username: "dora" });
    const missing = await ben.http.post(`/api/conversations/${groupId}/members`).send({ username: "nobody_here" });
    expect(exists.status).toBe(403);
    expect(exists.body).toEqual(missing.body);
  });

  it("promotes and demotes admins but never leaves a group without one", async () => {
    await asha.http.patch(`/api/conversations/${groupId}/members/${ben.id}`).send({ role: "admin" });
    expect(await roles(asha)).toMatchObject({ asha: "admin", ben: "admin" });
    await ben.http.patch(`/api/conversations/${groupId}/members/${asha.id}`).send({ role: "member" });
    const last = await ben.http.patch(`/api/conversations/${groupId}/members/${ben.id}`).send({ role: "member" });
    expect(last.status).toBe(400);
    expect(await roles(ben)).toEqual({ asha: "member", ben: "admin", chidi: "member" });
  });

  it("refuses group actions on a DM", async () => {
    const id = await dm(asha, ben);
    expect((await asha.http.patch(`/api/conversations/${id}`).send({ name: "x" })).status).toBe(403);
    expect((await asha.http.delete(`/api/conversations/${id}/members/${asha.id}`)).status).toBe(400);
    expect((await asha.http.post(`/api/conversations/${id}/invites`)).status).toBe(403);
  });
});

describe("removing a member", () => {
  it("cuts off their access to history, sending and live delivery at once", async () => {
    await send(asha, groupId, "secret plans");
    const c = await sock(chidi);
    expect((await asha.http.delete(`/api/conversations/${groupId}/members/${chidi.id}`)).status).toBe(200);
    expect(await c.waitFor("conversation:removed")).toEqual({ conversationId: groupId });

    await send(asha, groupId, "after chidi left");
    await sleep(150);
    expect(c.events.filter((e) => e.event === "message:new").map((e) => e.payload.message.text)).not.toContain("after chidi left");
    expect((await chidi.http.get(`/api/conversations/${groupId}/messages`)).status).toBe(404);
    expect((await chidi.http.get(`/api/conversations/${groupId}/changes?since=0`)).status).toBe(404);
    expect((await send(chidi, groupId, "still here?")).status).toBe(404);
    expect((await chidi.http.get("/api/conversations")).body.conversations).toEqual([]);
    expect(await lastTexts(ben)).toEqual(["secret plans", "Asha removed Chidi", "after chidi left"]);
  });

  it("also cuts off actions on messages they could see before", async () => {
    const m = (await send(chidi, groupId, "my own message")).body.message;
    await asha.http.delete(`/api/conversations/${groupId}/members/${chidi.id}`);
    expect((await chidi.http.patch(`/api/messages/${m.id}`).send({ text: "edit after removal" })).status).toBe(404);
    expect((await chidi.http.put(`/api/messages/${m.id}/reactions`).send({ emoji: "👍" })).status).toBe(404);
  });
});

describe("leaving", () => {
  it("lets any member leave and tells the rest", async () => {
    const a = await sock(asha);
    expect((await ben.http.delete(`/api/conversations/${groupId}/members/${ben.id}`)).status).toBe(200);
    await a.waitFor("message:new", (p) => p.message.text === "Ben left");
    expect(await roles(asha)).toEqual({ asha: "admin", chidi: "member" });
    expect((await ben.http.get(`/api/conversations/${groupId}`)).status).toBe(404);
  });

  it("hands admin to the longest-standing member when the last admin leaves", async () => {
    await asha.http.delete(`/api/conversations/${groupId}/members/${asha.id}`);
    const after = await roles(ben);
    expect(Object.values(after).filter((r) => r === "admin")).toHaveLength(1);
    expect(Object.keys(after).sort()).toEqual(["ben", "chidi"]);
  });

  it("deletes the group when the last member leaves", async () => {
    for (const u of [asha, ben, chidi]) await u.http.delete(`/api/conversations/${groupId}/members/${u.id}`);
    const { rows } = await t.db.query("SELECT count(*)::int AS n FROM conversations WHERE id = $1", [groupId]);
    expect(rows[0]!.n).toBe(0);
  });
});

describe("invite links", () => {
  const createInvite = async () => (await asha.http.post(`/api/conversations/${groupId}/invites`)).body.invite as { id: string; token: string };

  it("shows only the group's name and size before joining, then lets the holder in", async () => {
    await send(asha, groupId, "private until you join");
    const invite = await createInvite();
    const preview = await dora.http.get(`/api/invites/${invite.token}`);
    expect(preview.body.group).toEqual({ id: null, name: "Flat", avatarUrl: null, memberCount: 3, alreadyMember: false });
    expect((await dora.http.get(`/api/conversations/${groupId}/messages`)).status).toBe(404);

    const joined = await dora.http.post(`/api/invites/${invite.token}/accept`);
    expect(joined.body.conversation).toMatchObject({ id: groupId, myRole: "member" });
    expect(await lastTexts(dora)).toEqual(["private until you join", "Dora joined with an invite link"]);
  });

  it("is harmless to accept twice", async () => {
    const invite = await createInvite();
    await dora.http.post(`/api/invites/${invite.token}/accept`);
    await dora.http.post(`/api/invites/${invite.token}/accept`);
    expect((await details(asha)).members).toHaveLength(4);
    expect((await lastTexts(asha)).filter((x: string) => x.includes("joined"))).toHaveLength(1);
  });

  it("stops working once revoked or expired", async () => {
    const revoked = await createInvite();
    await asha.http.delete(`/api/conversations/${groupId}/invites/${revoked.id}`);
    expect((await dora.http.get(`/api/invites/${revoked.token}`)).status).toBe(404);
    expect((await dora.http.post(`/api/invites/${revoked.token}/accept`)).status).toBe(404);

    const expired = await createInvite();
    await t.db.query("UPDATE group_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    expect((await dora.http.post(`/api/invites/${expired.token}/accept`)).status).toBe(404);
    expect((await details(asha)).members).toHaveLength(3);
  });

  it("rejects a guessed token", async () => {
    expect((await dora.http.post("/api/invites/aaaaaaaaaaaaaaaaaaaaaaaa/accept")).status).toBe(404);
  });
});

describe("profile", () => {
  it("updates the name and avatar, and rotates the personal invite link", async () => {
    const renamed = await asha.http.patch("/api/auth/profile").send({ fullName: "Asha Rao" });
    expect(renamed.body.user.fullName).toBe("Asha Rao");
    const pic = await asha.http.post("/api/auth/avatar").attach("image", PNG, "me.png");
    expect(pic.body.user.avatarUrl).toMatch(/^\/uploads\//);

    const oldCode = pic.body.user.inviteCode;
    const rotated = await asha.http.post("/api/auth/invite-code");
    expect(rotated.body.user.inviteCode).not.toBe(oldCode);
    expect((await dora.http.post("/api/conversations/dm").send({ inviteCode: oldCode })).status).toBe(404);
    expect((await dora.http.post("/api/conversations/dm").send({ inviteCode: rotated.body.user.inviteCode })).status).toBe(201);
  });
});
