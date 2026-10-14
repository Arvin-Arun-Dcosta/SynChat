import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKEND_ROOT } from "../src/config.js";
import { EMBEDDING_DIM, EMBEDDING_MODEL, loadExtractor } from "../src/embedding/model.js";
import { EVAL_DIR } from "./datasets.js";

const CACHE_FILE = path.join(EVAL_DIR, ".cache", `${EMBEDDING_MODEL.replace(/\W+/g, "_")}.bin`);
const KEY_BYTES = 16;
const RECORD = KEY_BYTES + EMBEDDING_DIM * 4;

const keyOf = (text: string) => createHash("sha256").update(text).digest().subarray(0, KEY_BYTES).toString("hex");

/**
 * Embed texts with the same model the server uses, caching vectors on disk so a
 * second evaluation run (and every tuning run) costs nothing.
 */
export async function embedAll(texts: string[]): Promise<Map<string, Float32Array>> {
  const cache = new Map<string, Float32Array>();
  if (fs.existsSync(CACHE_FILE)) {
    const buf = fs.readFileSync(CACHE_FILE);
    for (let off = 0; off + RECORD <= buf.length; off += RECORD) {
      const vec = new Float32Array(EMBEDDING_DIM);
      for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] = buf.readFloatLE(off + KEY_BYTES + i * 4);
      cache.set(buf.subarray(off, off + KEY_BYTES).toString("hex"), vec);
    }
  }
  const missing = [...new Set(texts)].filter((t) => !cache.has(keyOf(t)));
  if (missing.length > 0) {
    console.error(`[embed] ${missing.length} new texts to embed (${cache.size} cached)`);
    const embed = await loadExtractor(path.join(BACKEND_ROOT, ".cache", "models"));
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const out = fs.openSync(CACHE_FILE, "a");
    const BATCH = 32;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vectors = await embed(batch);
      batch.forEach((text, k) => {
        const vec = vectors[k]!;
        const rec = Buffer.alloc(RECORD);
        Buffer.from(keyOf(text), "hex").copy(rec, 0);
        for (let d = 0; d < EMBEDDING_DIM; d++) rec.writeFloatLE(vec[d]!, KEY_BYTES + d * 4);
        fs.writeSync(out, rec);
        cache.set(keyOf(text), vec);
      });
      if ((i / BATCH) % 25 === 0) console.error(`[embed] ${Math.min(i + BATCH, missing.length)}/${missing.length}`);
    }
    fs.closeSync(out);
  }
  const result = new Map<string, Float32Array>();
  for (const t of texts) result.set(t, cache.get(keyOf(t))!);
  return result;
}
