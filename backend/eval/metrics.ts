/**
 * The standard conversation-disentanglement metrics, implemented to match the
 * reference script of Kummerfeld et al. (2019), tools/evaluation/conversation-eval.py:
 * scores are pooled over all files, and a cluster never spans two files.
 */

/** For one file (or chat): the cluster id of each evaluated message. */
export interface Clustering {
  file: string;
  gold: string[];
  pred: string[];
}

export interface Scores {
  messages: number;
  goldClusters: number;
  predClusters: number;
  /** 100 * (1 - VI / log2 N). Higher is better. */
  vi: number;
  /** Percentage of messages in agreement under the best one-to-one matching of clusters. */
  oneToOne: number;
  /** Exact-match precision/recall/F1 over clusters, ignoring clusters of one message. */
  precision: number;
  recall: number;
  f1: number;
  /** Adjusted Rand index * 100. */
  ari: number;
}

/** Maximum-weight assignment (Hungarian algorithm) on a rectangular matrix. Returns the total. */
export function maxAssignment(weights: number[][]): number {
  const rows = weights.length;
  const cols = weights[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return 0;
  // Solve as a min-cost problem on a square matrix with n = max(rows, cols).
  const n = Math.max(rows, cols);
  let max = 0;
  for (const r of weights) for (const w of r) if (w > max) max = w;
  const cost = (i: number, j: number) => max - (i < rows && j < cols ? weights[i]![j]! : 0);
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const match = new Int32Array(n + 1); // match[j] = row assigned to column j (1-based), 0 = none
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    match[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = match[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[match[j]!] = u[match[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (match[j0] !== 0);
    do {
      const j1 = way[j0]!;
      match[j0] = match[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= n; j++) {
    const i = match[j]! - 1;
    if (i >= 0 && i < rows && j - 1 < cols) total += weights[i]![j - 1]!;
  }
  return total;
}

export function score(clusterings: Clustering[]): Scores {
  let N = 0;
  for (const c of clusterings) N += c.gold.length;
  let hJoint = 0;
  let mutual = 0;
  let hGold = 0;
  let hPred = 0;
  let overlap = 0;
  let goldClusters = 0;
  let predClusters = 0;
  let goldMulti = 0;
  let predMulti = 0;
  let matched = 0;
  let pairsBoth = 0;
  let pairsGold = 0;
  let pairsPred = 0;
  const choose2 = (n: number) => (n * (n - 1)) / 2;
  const log2 = Math.log2;

  for (const c of clusterings) {
    const gold = new Map<string, number[]>();
    const pred = new Map<string, number[]>();
    c.gold.forEach((g, i) => (gold.get(g) ?? gold.set(g, []).get(g)!).push(i));
    c.pred.forEach((p, i) => (pred.get(p) ?? pred.set(p, []).get(p)!).push(i));
    goldClusters += gold.size;
    predClusters += pred.size;

    const goldIds = [...gold.keys()];
    const predIds = [...pred.keys()];
    const predIndex = new Map(predIds.map((id, j) => [id, j]));
    const table = goldIds.map(() => new Array<number>(predIds.length).fill(0));
    goldIds.forEach((g, gi) => {
      for (const i of gold.get(g)!) table[gi]![predIndex.get(c.pred[i]!)!]!++;
    });

    goldIds.forEach((g, gi) => {
      const size = gold.get(g)!.length;
      hGold -= (size / N) * log2(size / N);
      pairsGold += choose2(size);
      if (size > 1) goldMulti++;
      predIds.forEach((p, pj) => {
        const n = table[gi]![pj]!;
        if (n === 0) return;
        const psize = pred.get(p)!.length;
        hJoint -= (n / N) * log2(n / N);
        mutual += (n / N) * log2((n * N) / (size * psize));
        pairsBoth += choose2(n);
        // An exact match: the two clusters contain precisely the same messages.
        if (size > 1 && n === size && n === psize) matched++;
      });
    });
    for (const p of predIds) {
      const size = pred.get(p)!.length;
      hPred -= (size / N) * log2(size / N);
      pairsPred += choose2(size);
      if (size > 1) predMulti++;
    }
    overlap += maxAssignment(table);
  }

  const vi = hJoint - mutual; // = H(gold|pred) + H(pred|gold)
  const expected = (pairsGold * pairsPred) / choose2(N);
  const maxIndex = 0.5 * (pairsGold + pairsPred);
  const precision = predMulti ? (100 * matched) / predMulti : 0;
  const recall = goldMulti ? (100 * matched) / goldMulti : 0;
  void hGold;
  void hPred;
  return {
    messages: N,
    goldClusters,
    predClusters,
    vi: Math.min(100, 100 - (100 * vi) / log2(N)),
    oneToOne: (100 * overlap) / N,
    precision,
    recall,
    f1: matched ? (2 * precision * recall) / (precision + recall) : 0,
    ari: maxIndex === expected ? 100 : (100 * (pairsBoth - expected)) / (maxIndex - expected),
  };
}

export function formatScores(label: string, s: Scores): string {
  const f = (x: number) => x.toFixed(1).padStart(5);
  return `${label.padEnd(34)} VI ${f(s.vi)}  1-1 ${f(s.oneToOne)}  P ${f(s.precision)}  R ${f(s.recall)}  F1 ${f(s.f1)}  ARI ${f(s.ari)}   (${s.messages} msgs, ${s.goldClusters} gold / ${s.predClusters} predicted clusters)`;
}
