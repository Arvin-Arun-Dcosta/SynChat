import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { findSession, tokenFromCookieHeader } from "../auth/sessions.js";
import type { Ctx } from "../ctx.js";
import type { Me } from "../types.js";
import { HttpError, forbidden, unauthorized } from "./errors.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: Me;
    sessionId?: string;
  }
}

/** Reject the request with 401 unless it carries a valid session cookie. */
export function requireAuth(ctx: Ctx): RequestHandler {
  return async (req, _res, next) => {
    const session = await findSession(ctx.db, tokenFromCookieHeader(req.headers.cookie), ctx.config.sessionTtlMs);
    if (!session) throw unauthorized();
    req.user = session.user;
    req.sessionId = session.sessionId;
    next();
  };
}

/** The signed-in user. Only call in routes behind requireAuth. */
export function me(req: Request): Me {
  if (!req.user) throw unauthorized();
  return req.user;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth. The session cookie is SameSite=Lax already; this also refuses
 * any state-changing request whose Origin header is not one of ours.
 */
export function originCheck(ctx: Ctx): RequestHandler {
  const allowed = new Set(ctx.config.clientOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser client; it has no ambient cookies to abuse
    if (allowed.has(origin)) return next();
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {
      /* fall through */
    }
    next(forbidden("Cross-origin request refused"));
  };
}

export interface LimitOptions {
  windowMs: number;
  limit: number;
  /** What to count against: the client IP, the signed-in user, or a custom key. */
  by?: "ip" | "user" | ((req: Request) => string);
  skipSuccessfulRequests?: boolean;
}

const passthrough: RequestHandler = (_req, _res, next) => next();

/**
 * Rate limiter. Counters live in process memory, which is right for one instance;
 * with several instances pass express-rate-limit a shared `store` (e.g. Redis) here.
 */
export function limiter(ctx: Ctx, opts: LimitOptions): RequestHandler {
  if (!ctx.config.rateLimits) return passthrough;
  const by = opts.by ?? "ip";
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    keyGenerator: (req) => {
      if (typeof by === "function") return by(req);
      if (by === "user" && req.user) return "u:" + req.user.id;
      return ipKeyGenerator(req.ip ?? "unknown");
    },
    handler: (_req, _res, next) => next(new HttpError(429, "rate_limited", "Too many requests. Wait a moment and try again.")),
  });
}
