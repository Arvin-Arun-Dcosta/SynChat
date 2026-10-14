/**
 * The sentence-embedding model. Small, multilingual, and run on our own CPU: message
 * text never leaves the server to be embedded.
 *
 * Changing the model means re-embedding stored messages, and a model with a different
 * output size also needs a migration (the vector column is declared with this size).
 */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;
/** Longer messages are cut here before embedding; the model reads ~128 tokens anyway. */
export const MAX_EMBED_CHARS = 1000;

export type Extractor = (texts: string[]) => Promise<Float32Array[]>;

/** Load the model (downloading it to `cacheDir` on first use) and return an embed function. */
export async function loadExtractor(cacheDir: string): Promise<Extractor> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  const extract = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
  return async (texts) => {
    const output = await extract(texts.map((t) => t.slice(0, MAX_EMBED_CHARS)), { pooling: "mean", normalize: true });
    const [n, dim] = output.dims as [number, number];
    if (dim !== EMBEDDING_DIM) throw new Error(`${EMBEDDING_MODEL} produces ${dim}-d vectors, expected ${EMBEDDING_DIM}`);
    const data = output.data as Float32Array;
    return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim));
  };
}

/** Cosine similarity of two unit-length vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
