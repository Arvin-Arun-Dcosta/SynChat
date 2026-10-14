import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { DigestService } from "./digest/service.js";
import type { Embedder } from "./embedding/embedder.js";
import type { LaneService } from "./lanes/service.js";
import type { PushService } from "./push/service.js";
import type { Realtime } from "./realtime/realtime.js";
import type { ImageStorage } from "./uploads/storage.js";

/** Everything a request handler needs. Built once in createApp and passed down. */
export interface Ctx {
  config: Config;
  db: Db;
  rt: Realtime;
  /** Where uploaded images go, or null when image upload is unavailable. */
  images: ImageStorage | null;
  /** Topic lanes: embeds messages and assigns them to topics, off the request path. */
  lanes: LaneService | null;
  /** The LLM-backed features. Null when no API key is configured: they then do not exist. */
  digest: DigestService | null;
  /** Web push notifications. Null when no VAPID keys are configured. */
  push: PushService | null;
  /** Turns text into vectors. Shared by lane assignment and meaning search. */
  embedder: Embedder | null;
}
