import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ORIGIN, PASSWORD, resetDb, signup, startApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());
beforeEach(() => resetDb(t.db));

const valid = { email: "asha@example.com", username: "asha", fullName: "Asha", password: PASSWORD };

describe("signup", () => {
  it("creates an account and sets an httpOnly session cookie", async () => {
    const res = await request(t.url).post("/api/auth/signup").send(valid);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "asha@example.com", username: "asha", fullName: "Asha" });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("stores a bcrypt hash at cost 12 by default, never the password", async () => {
    const real = await startApp({ bcryptCost: loadConfig({ ...process.env, BCRYPT_COST: undefined }).bcryptCost });
    try {
      await request(real.url).post("/api/auth/signup").send(valid);
      const { rows } = await real.db.query("SELECT password_hash FROM users WHERE username = 'asha'");
      expect(rows[0]!.password_hash).toMatch(/^\$2[aby]\$12\$/);
      expect(rows[0]!.password_hash).not.toContain(PASSWORD);
    } finally {
      await real.close();
    }
  });

  it("refuses a weak hashing cost in production", () => {
    expect(loadConfig({ ...process.env, NODE_ENV: "production", BCRYPT_COST: "4" }).bcryptCost).toBe(12);
  });

  it.each([
    ["a 9-character password", { password: "ninechars" }],
    ["a common password", { password: "password123" }],
    ["a password longer than bcrypt can read", { password: "x".repeat(73) }],
    ["a password containing the username", { password: "asha-is-my-name" }],
    ["a malformed email", { email: "not-an-email" }],
    ["a username with spaces", { username: "as ha" }],
    ["a 2-character username", { username: "as" }],
    ["an empty name", { fullName: "   " }],
  ])("rejects %s with 400", async (_label, patch) => {
    const res = await request(t.url).post("/api/auth/signup").send({ ...valid, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("rejects a duplicate username or email with 409, case-insensitively", async () => {
    await request(t.url).post("/api/auth/signup").send(valid);
    const sameName = await request(t.url).post("/api/auth/signup").send({ ...valid, email: "other@example.com", username: "ASHA" });
    expect(sameName.status).toBe(409);
    const sameEmail = await request(t.url).post("/api/auth/signup").send({ ...valid, email: "Asha@Example.com", username: "asha2" });
    expect(sameEmail.status).toBe(409);
  });
});

describe("login and sessions", () => {
  it("logs in with email or username", async () => {
    await signup(t, "asha");
    for (const identifier of ["asha@example.com", "asha", "ASHA"]) {
      const res = await request(t.url).post("/api/auth/login").send({ identifier, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe("asha");
    }
  });

  it("answers 401 with the same message for a wrong password and an unknown user", async () => {
    await signup(t, "asha");
    const wrong = await request(t.url).post("/api/auth/login").send({ identifier: "asha", password: "wrong password!" });
    const unknown = await request(t.url).post("/api/auth/login").send({ identifier: "nobody", password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("answers 401, not 500, for a missing or invalid session cookie", async () => {
    const none = await request(t.url).get("/api/auth/me");
    expect(none.status).toBe(401);
    for (const cookie of ["sid=garbage", "sid=", "jwt=eyJhbGciOiJIUzI1NiJ9.e30.x", "sid=" + "a".repeat(5000)]) {
      const res = await request(t.url).get("/api/auth/me").set("Cookie", cookie);
      expect(res.status).toBe(401);
    }
  });

  it("revokes the session on logout, so the old cookie stops working", async () => {
    const asha = await signup(t, "asha");
    expect((await asha.http.get("/api/auth/me")).status).toBe(200);
    expect((await asha.http.post("/api/auth/logout")).status).toBe(200);
    const replay = await request(t.url).get("/api/auth/me").set("Cookie", asha.cookie);
    expect(replay.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const asha = await signup(t, "asha");
    await t.db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await asha.http.get("/api/auth/me")).status).toBe(401);
  });

  it("keeps only a hash of the session token in the database", async () => {
    const asha = await signup(t, "asha");
    const token = asha.cookie.replace(/^sid=/, "");
    const { rows } = await t.db.query("SELECT token_hash FROM sessions");
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.token_hash).toString("utf8")).not.toContain(token);
    expect(rows[0]!.token_hash).toHaveLength(32);
  });
});

describe("hardening", () => {
  it("rate-limits repeated failed logins", async () => {
    const limited = await startApp({ rateLimits: true });
    try {
      await signup(limited, "asha");
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await request(limited.url).post("/api/auth/login").send({ identifier: "asha", password: "wrong password!" });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(8)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it("only allows the configured origin through CORS", async () => {
    const ok = await request(t.url).get("/api/health").set("Origin", ORIGIN);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const evil = await request(t.url).get("/api/health").set("Origin", "https://evil.example");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses state-changing requests from another origin", async () => {
    const asha = await signup(t, "asha");
    const res = await asha.http.post("/api/auth/logout").set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    expect((await asha.http.get("/api/auth/me")).status).toBe(200);
  });

  it("answers 400 for malformed JSON and 413 for an oversized body", async () => {
    const bad = await request(t.url).post("/api/auth/login").set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    const huge = await request(t.url).post("/api/auth/login").send({ identifier: "a", password: "x".repeat(200_000) });
    expect(huge.status).toBe(413);
  });
});

describe("finding people", () => {
  it("has no endpoint that lists users", async () => {
    const asha = await signup(t, "asha");
    await signup(t, "ben");
    for (const path of ["/api/users", "/api/messages/users", "/api/users/lookup", "/api/users/lookup?username="]) {
      const res = await asha.http.get(path);
      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain("ben");
    }
  });

  it("resolves an exact username only, and never returns an email", async () => {
    const asha = await signup(t, "asha");
    await signup(t, "benjamin");
    const exact = await asha.http.get("/api/users/lookup?username=Benjamin");
    expect(exact.status).toBe(200);
    expect(exact.body.user).toEqual({ id: expect.any(String), username: "benjamin", fullName: "Benjamin", avatarUrl: null });
    for (const partial of ["ben", "benjami", "benjamin_", "%25", "ben%25"]) {
      expect((await asha.http.get(`/api/users/lookup?username=${partial}`)).status).not.toBe(200);
    }
  });

  it("requires a session to look anyone up", async () => {
    await signup(t, "ben");
    expect((await request(t.url).get("/api/users/lookup?username=ben")).status).toBe(401);
  });

  it("resolves a personal invite code", async () => {
    const asha = await signup(t, "asha");
    const ben = await signup(t, "ben");
    const code = (await ben.http.get("/api/auth/me")).body.user.inviteCode;
    const res = await asha.http.get(`/api/users/invite/${code}`);
    expect(res.body.user.username).toBe("ben");
    expect((await asha.http.get("/api/users/invite/doesnotexist1")).status).toBe(404);
  });
});
