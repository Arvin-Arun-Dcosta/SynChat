import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env, ModelRegistry } from "@huggingface/transformers";
import { DEFAULT_MODEL_CACHE_DIR } from "./config.js";
import { EMBEDDING_MODEL } from "./embedding/model.js";

// Downloads the embedding model's files ahead of time, e.g. in a host's build step,
// so the server only has to load them at startup. Downloading and loading in one
// process needs more memory than a 512 MB instance has, so this only downloads,
// streaming each file to disk where the library looks for it.
const cacheDir = process.env.MODEL_CACHE_DIR || DEFAULT_MODEL_CACHE_DIR;
const files = await ModelRegistry.get_pipeline_files("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });

for (const file of files) {
  const dest = path.join(cacheDir, EMBEDDING_MODEL, file);
  if (fs.existsSync(dest)) continue;
  const url = env.remoteHost + env.remotePathTemplate.replace("{model}", EMBEDDING_MODEL).replace("{revision}", "main") + file;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${dest}.part`));
  fs.renameSync(`${dest}.part`, dest);
  console.log(`[model] ${file}`);
}
console.log(`[model] ${EMBEDDING_MODEL} is in ${cacheDir}`);
