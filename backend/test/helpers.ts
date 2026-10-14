import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import request from "supertest";
import { createApp, type App } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { Db } from "../src/db.js";
import type { DigestModel } from "../src/digest/model.js";
import type { Embedder } from "../src/embedding/embedder.js";
import type { PushSender } from "../src/push/service.js";

export const ORIGIN = "http://localhost:5173";
export const PASSWORD = "correct horse battery";

export interface TestApp {
  app: App;
  db: Db;
  config: Config;
  url: string;
  close(): Promise<void>;
}

/**
 * A stand-in for the sentence model: a bag of hashed words. Messages that share
 * words get similar vectors, which is all the lane tests need, with no download.
 */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-bag-of-words";
  /** `synonyms` maps a word to the word it "means", so tests can stage a meaning-only match. */
  constructor(private readonly synonyms: Record<string, string> = {}) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(384);
      for (const raw of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
        const word = this.synonyms[raw] ?? raw;
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
        v[(h >>> 0) % 384]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
  async close(): Promise<void> {}
}

/** `lanes: true` turns on topic lanes (with the fake embedder); most suites run without. */
export async function startApp(overrides: Partial<Config> = {}, opts: { lanes?: boolean; embedder?: Embedder; digestModel?: DigestModel; pushSender?: PushSender } = {}): Promise<TestApp> {
  const config = {
    ...loadConfig({ ...process.env, RATE_LIMITS: "false", BCRYPT_COST: "4", UPLOAD_DIR: path.join(os.tmpdir(), "synchat-test-uploads") }),
    ...overrides,
  };
  const db = new Db(config.databaseUrl);
  const app = createApp(config, db, { realtime: { presenceGraceMs: 60 }, lanes: opts.lanes ?? false, embedder: opts.embedder ?? (opts.lanes ? new FakeEmbedder() : null), digestModel: opts.digestModel ?? null, pushSender: opts.pushSender ?? null });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    app,
    db,
    config,
    url,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  if (rows.length > 0) {
    await db.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
}

export interface TestUser {
  id: string;
  username: string;
  email: string;
  cookie: string;
  /** A supertest agent that carries this user's session cookie. */
  http: ReturnType<typeof request.agent>;
}

export async function signup(t: TestApp, username: string): Promise<TestUser> {
  const http = request.agent(t.url);
  const email = `${username}@example.com`;
  const res = await http
    .post("/api/auth/signup")
    .send({ email, username, fullName: username[0]!.toUpperCase() + username.slice(1), password: PASSWORD });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
  return { id: res.body.user.id, username, email, cookie, http };
}

export async function dm(a: TestUser, b: TestUser): Promise<string> {
  const res = await a.http.post("/api/conversations/dm").send({ username: b.username });
  if (res.status >= 300) throw new Error(`dm failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.conversation.id;
}

export async function group(creator: TestUser, name: string, others: TestUser[]): Promise<string> {
  const res = await creator.http.post("/api/conversations/group").send({ name, usernames: others.map((o) => o.username) });
  if (res.status !== 201) throw new Error(`group failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.conversation.id;
}

export function send(user: TestUser, conversationId: string, text: string, extra: Record<string, unknown> = {}) {
  return user.http.post(`/api/conversations/${conversationId}/messages`).send({ id: randomUUID(), text, ...extra });
}

export interface TestSocket {
  socket: Socket;
  /** Every event received so far, in order. */
  events: { event: string; payload: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Resolve with the first (already received or future) event matching the predicate. */
  waitFor(event: string, match?: (payload: any) => boolean, timeoutMs?: number): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): void;
}

export function connect(t: TestApp, cookie?: string, opts: { query?: Record<string, string> } = {}): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(t.url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      query: opts.query,
      extraHeaders: cookie ? { cookie } : undefined,
    });
    const events: TestSocket["events"] = [];
    const waiters: { event: string; match: (p: unknown) => boolean; resolve: (p: unknown) => void }[] = [];
    socket.onAny((event: string, payload: unknown) => {
      events.push({ event, payload });
      for (const w of [...waiters]) {
        if (w.event === event && w.match(payload)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(payload);
        }
      }
    });
    const api: TestSocket = {
      socket,
      events,
      waitFor(event, match = () => true, timeoutMs = 3000) {
        const seen = events.find((e) => e.event === event && match(e.payload));
        if (seen) return Promise.resolve(seen.payload);
        return new Promise((res, rej) => {
          const waiter = { event, match, resolve: res };
          const timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            rej(new Error(`timed out waiting for "${event}"`));
          }, timeoutMs);
          waiter.resolve = (p) => {
            clearTimeout(timer);
            res(p);
          };
          waiters.push(waiter);
        });
      },
      close: () => socket.close(),
    };
    socket.once("connect", () => resolve(api));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The smallest valid PNG: one transparent pixel. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export async function uploadImage(user: TestUser, buf: Buffer = PNG, filename = "pic.png"): Promise<{ id: string; url: string }> {
  const res = await user.http.post("/api/uploads/image").attach("image", buf, filename);
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.upload;
}
