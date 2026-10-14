import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");
export const DEFAULT_MODEL_CACHE_DIR = path.join(BACKEND_ROOT, ".cache", "models");

// Tests set their own environment; they must never pick up a developer's .env.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: [path.join(REPO_ROOT, ".env"), path.join(BACKEND_ROOT, ".env")], quiet: true });
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = z.preprocess(emptyToUndefined, z.string().optional());
const bool = (fallback: boolean) =>
  z.preprocess(emptyToUndefined, z.enum(["true", "false", "1", "0"]).optional()).transform((v) =>
    v === undefined ? fallback : v === "true" || v === "1",
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(5001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (see .env.example)"),
  // Comma-separated list of extra browser origins allowed to call the API with credentials.
  // The API's own host is always allowed, so this is only needed when the web app is
  // served from a different origin. Defaults to the Vite dev server outside production.
  CLIENT_ORIGIN: optional,
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: bool(false).optional(),
  // Set to the number of reverse proxies in front of the app so rate limits see real IPs.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  AUTO_MIGRATE: bool(true),
  RATE_LIMITS: bool(true),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  // The three LLM-backed features exist only when a key is set.
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().default("claude-haiku-5-5")),
  // Google Gemini can run the same features instead. If both keys are set, LLM_PROVIDER picks.
  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.preprocess(emptyToUndefined, z.string().default("gemini-3.5-flash-lite")),
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["anthropic", "google"]).optional()),
  // Development only: a rule-based stand-in (not AI) so the AI screens can be exercised without a key.
  LLM_STUB: bool(false),
  // A topic is digested once nothing has been said in it for this long.
  DIGEST_QUIET_SECONDS: z.coerce.number().min(0.05).max(3600).default(90),
  // ...and, however often it is asked for, not again sooner than this.
  DIGEST_MIN_INTERVAL_SECONDS: z.coerce.number().min(0).max(3600).default(20),
  // In a group that never goes quiet, the AI pass runs anyway after this long.
  DIGEST_MAX_WAIT_SECONDS: z.coerce.number().min(1).max(86400).default(600),
  // Web push. Generate a pair with `npm run vapid --prefix backend`. Without them, notifications are off.
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.preprocess(emptyToUndefined, z.string().default("mailto:admin@example.com")),
  CLOUDINARY_CLOUD_NAME: optional,
  CLOUDINARY_API_KEY: optional,
  CLOUDINARY_API_SECRET: optional,
  UPLOAD_DIR: z.string().default(path.join(BACKEND_ROOT, "uploads")),
  // Where the sentence-embedding model is downloaded to on first use (~130 MB).
  MODEL_CACHE_DIR: z.string().default(DEFAULT_MODEL_CACHE_DIR),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error("Invalid environment:\n" + z.prettifyError(parsed.error));
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  const cloudinary =
    e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET
      ? { cloudName: e.CLOUDINARY_CLOUD_NAME, apiKey: e.CLOUDINARY_API_KEY, apiSecret: e.CLOUDINARY_API_SECRET }
      : null;
  return {
    env: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === "test",
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    clientOrigins: (e.CLIENT_ORIGIN ?? (isProd ? "" : "http://localhost:5173")).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
    sessionTtlMs: e.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    cookieSecure: e.COOKIE_SECURE ?? isProd,
    trustProxy: e.TRUST_PROXY,
    autoMigrate: e.AUTO_MIGRATE,
    rateLimits: e.RATE_LIMITS,
    // Never weaker than 12 in production, whatever the environment says.
    bcryptCost: isProd ? Math.max(12, e.BCRYPT_COST) : e.BCRYPT_COST,
    cloudinary,
    llm: e.ANTHROPIC_API_KEY && e.LLM_PROVIDER !== "google" ? { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL } : null,
    // Used when it is the only key, or when LLM_PROVIDER says so.
    gemini: e.GEMINI_API_KEY && (e.LLM_PROVIDER === "google" || !e.ANTHROPIC_API_KEY) ? { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL } : null,
    // Ignored when a real key is set, and always in production.
    llmStub: e.LLM_STUB && !isProd && !e.ANTHROPIC_API_KEY && !e.GEMINI_API_KEY,
    digestQuietMs: e.DIGEST_QUIET_SECONDS * 1000,
    digestMinIntervalMs: e.DIGEST_MIN_INTERVAL_SECONDS * 1000,
    digestMaxWaitMs: e.DIGEST_MAX_WAIT_SECONDS * 1000,
    vapid: e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT } : null,
    uploadDir: e.UPLOAD_DIR,
    modelCacheDir: e.MODEL_CACHE_DIR,
  };
}
