import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { authRoutes } from "./auth/routes.js";
import { REPO_ROOT, type Config } from "./config.js";
import { conversationRoutes, inviteRoutes } from "./conversations/routes.js";
import type { Ctx } from "./ctx.js";
import type { Db } from "./db.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { originCheck } from "./http/middleware.js";
import { ClaudeLlm, GeminiLlm } from "./digest/llm.js";
import { PromptedDigestModel, type DigestModel } from "./digest/model.js";
import { digestTopicRoutes, inboxRoutes } from "./digest/routes.js";
import { DigestService } from "./digest/service.js";
import { StubDigestModel } from "./digest/stub.js";
import { WorkerEmbedder, type Embedder } from "./embedding/embedder.js";
import { InProcessQueue } from "./jobs/queue.js";
import { DEFAULT_PARAMS, type LaneParams } from "./lanes/params.js";
import { topicRoutes } from "./lanes/routes.js";
import { LaneService } from "./lanes/service.js";
import { messageRoutes } from "./messages/routes.js";
import { pushRoutes } from "./push/routes.js";
import { PushService, WebPushSender, type PushSender } from "./push/service.js";
import { Realtime, type RealtimeOptions } from "./realtime/realtime.js";
import { searchRoutes } from "./search/routes.js";
import { uploadRoutes } from "./uploads/routes.js";
import { createImageStorage } from "./uploads/storage.js";
import { userRoutes } from "./users/routes.js";

export interface App {
  ctx: Ctx;
  express: express.Express;
  server: http.Server;
  close(): Promise<void>;
}

export interface AppOptions {
  realtime?: RealtimeOptions;
  /** How messages are embedded. Pass null to run lanes on conversational signals only. */
  embedder?: Embedder | null;
  /** Set false to run without topic lanes at all. */
  lanes?: boolean;
  laneParams?: LaneParams;
  /** How push notifications are delivered. Default: Web Push if VAPID keys are configured, else none. */
  pushSender?: PushSender | null;
  /** The model behind the LLM features. Default: Claude if an API key is configured, else none. */
  digestModel?: DigestModel | null;
}

export function createApp(config: Config, db: Db, opts: AppOptions = {}): App {
  const app = express();
  const server = http.createServer(app);
  const rt = new Realtime(server, db, config, opts.realtime);
  const images = createImageStorage(config);
  const embedder = opts.embedder === undefined ? new WorkerEmbedder(config.modelCacheDir) : opts.embedder;
  const lanes = opts.lanes === false ? null : new LaneService(db, rt, new InProcessQueue(), embedder, opts.laneParams ?? DEFAULT_PARAMS);
  const digestModel =
    opts.digestModel !== undefined
      ? opts.digestModel
      : config.llm
        ? new PromptedDigestModel(new ClaudeLlm(config.llm.apiKey, config.llm.model))
        : config.gemini
          ? new PromptedDigestModel(new GeminiLlm(config.gemini.apiKey, config.gemini.model))
          : config.llmStub
          ? new StubDigestModel()
          : null;
  const digest = digestModel ? new DigestService(db, rt, new InProcessQueue(), digestModel, { quietMs: config.digestQuietMs, minIntervalMs: config.digestMinIntervalMs, maxWaitMs: config.digestMaxWaitMs }) : null;
  if (lanes && digest) lanes.onTopicActivity = (conversationId, topicId) => digest.topicActive(conversationId, topicId);
  const pushSender = opts.pushSender === undefined ? (config.vapid ? new WebPushSender(config.vapid) : null) : opts.pushSender;
  const push = pushSender ? new PushService(db, rt, pushSender) : null;
  // In a group, notify once the topic is known, so topic mute can be honoured.
  if (lanes && push) lanes.onMessageReady = (messageId) => void push.notifyMessage(messageId).catch((err) => console.error("[push]", (err as Error).message));
  const ctx: Ctx = { config, db, rt, images, lanes, embedder, digest, push };

  app.disable("x-powered-by");
  if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);

  app.use(
    helmet({
      // The API only returns JSON. A CSP for the built frontend is set where it is served.
      contentSecurityPolicy: config.isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
              connectSrc: ["'self'", "ws:", "wss:"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              workerSrc: ["'self'"],
              // Only ask browsers to upgrade to https when we are actually served over it.
              upgradeInsecureRequests: config.cookieSecure ? [] : null,
            },
          }
        : false,
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );
  app.use(cors({ origin: config.clientOrigins, credentials: true }));
  app.use(express.json({ limit: "64kb" }));
  app.use(originCheck(ctx));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  /** What this server can do, so the client can hide what is not available. */
  app.get("/api/config", (_req, res) => {
    res.json({ features: { imageUpload: images !== null, llm: digest !== null, push: push !== null }, aiProvider: digestModel?.providerLabel ?? null, vapidPublicKey: push ? (config.vapid?.publicKey ?? null) : null });
  });
  app.use("/api/auth", authRoutes(ctx));
  app.use("/api/users", userRoutes(ctx));
  app.use("/api/conversations", conversationRoutes(ctx));
  app.use("/api/messages", messageRoutes(ctx));
  app.use("/api/topics", topicRoutes(ctx));
  app.use("/api/topics", digestTopicRoutes(ctx));
  app.use("/api/inbox", inboxRoutes(ctx));
  app.use("/api/push", pushRoutes(ctx));
  app.use("/api/search", searchRoutes(ctx));
  app.use("/api/invites", inviteRoutes(ctx));
  app.use("/api/uploads", uploadRoutes(ctx));
  app.use("/api", notFoundHandler);

  // Development image store. Names are random; nothing but image bytes is ever written here.
  if (images?.kind === "local") {
    app.use("/uploads", express.static(config.uploadDir, { index: false, dotfiles: "deny", maxAge: "7d", immutable: true }));
  }

  // In production the API also serves the built frontend, so there is one origin.
  const dist = path.join(REPO_ROOT, "frontend", "dist");
  if (config.isProd && fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  app.use(errorHandler);

  return {
    ctx,
    express: app,
    server,
    async close() {
      await lanes?.idle().catch(() => {});
      digest?.close();
      await digest?.idle().catch(() => {});
      await embedder?.close().catch(() => {});
      await rt.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
