import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Db, migrate } from "./db.js";

const config = loadConfig();
const db = new Db(config.databaseUrl);

if (config.autoMigrate) {
  await migrate(db, (m) => console.log("[migrate]", m));
}
// Expired sessions are useless; clear them out at boot and then daily.
const purgeSessions = () => db.query("DELETE FROM sessions WHERE expires_at < now()").catch(() => {});
void purgeSessions();
setInterval(purgeSessions, 24 * 60 * 60 * 1000).unref();

const app = createApp(config, db);
app.server.listen(config.port, () => {
  console.log(`[synchat] API listening on http://localhost:${config.port} (${config.env})`);
  if (!config.cloudinary) {
    console.log(config.isProd ? "[synchat] Cloudinary not configured: image upload is off" : "[synchat] Cloudinary not configured: images are stored on local disk");
  }
  console.log(
    config.llm || config.gemini
      ? `[synchat] AI features available (${config.llm ? `Anthropic, ${config.llm.model}` : `Google, ${config.gemini!.model}`}); off in each group until its admin turns them on`
      : config.llmStub
        ? "[synchat] LLM_STUB is on: the AI screens are fed by a rule-based stand-in, NOT a model. For development only."
        : "[synchat] No ANTHROPIC_API_KEY or GEMINI_API_KEY: the AI features (lane tidy-up, catch-up, status, questions inbox) are hidden",
  );
  if (!config.vapid) console.log("[synchat] No VAPID keys: push notifications are off (npm run vapid --prefix backend)");
  const started = Date.now();
  void app.ctx.lanes?.warmUp().then((ok) => ok && console.log(`[lanes] embedding model ready (${((Date.now() - started) / 1000).toFixed(1)}s)`));
  // Pick up any messages that were waiting for a topic when the server last stopped.
  void app.ctx.lanes
    ?.recover()
    .then((n) => n > 0 && console.log(`[lanes] resuming ${n} unprocessed messages`))
    .catch((err) => console.error("[lanes] recovery failed:", (err as Error).message));
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[synchat] ${signal}, shutting down`);
  await app.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
