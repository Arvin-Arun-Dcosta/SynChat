/**
 * Centring: comparing two messages after removing what all of a conversation's
 * messages have in common.
 *
 * Sentence models place texts of one language and register near each other, whatever
 * they are about. For romanised Hindi the effect is extreme: any two messages score
 * 0.3 to 0.9, against 0.1 to 0.3 for English, so no single similarity threshold can
 * serve both. Subtracting the conversation's mean vector removes that shared part.
 * What remains is centred on zero in every language: about 0 for unrelated messages,
 * clearly positive for related ones. On the hand-labelled chats it also picks the
 * right lane slightly more often (eval/topic-probe.ts).
 *
 * The mean is shrunk toward zero while a conversation is young, when the mean of two
 * or three messages would be mostly those messages themselves.
 */
export const CENTRE_PRIOR = 5;

/** Mean of the given vectors, shrunk toward zero as if CENTRE_PRIOR zero vectors were added. */
export function shrunkMean(vectors: Float32Array[], dim: number): Float32Array {
  const mean = new Float32Array(dim);
  for (const v of vectors) for (let d = 0; d < dim; d++) mean[d]! += v[d]!;
  const n = vectors.length + CENTRE_PRIOR;
  for (let d = 0; d < dim; d++) mean[d]! /= n;
  return mean;
}

/** Cosine similarity of a and b after subtracting `mean` from both. */
export function centredCosine(a: Float32Array, b: Float32Array, mean: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d++) {
    const x = a[d]! - mean[d]!;
    const y = b[d]! - mean[d]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
