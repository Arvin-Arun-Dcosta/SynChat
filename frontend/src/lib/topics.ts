import type { Topic } from "../types";

// Ten hues spaced far enough apart to tell at a glance.
const HUES = [212, 4, 142, 32, 280, 176, 330, 52, 250, 100];

/** A stable colour for a topic, so its chip looks the same everywhere and for everyone. */
export function topicHue(topicId: string): number {
  let h = 2166136261;
  for (let i = 0; i < topicId.length; i++) h = Math.imul(h ^ topicId.charCodeAt(i), 16777619);
  return HUES[(h >>> 0) % HUES.length]!;
}

export const topicColor = (topicId: string) => `hsl(${topicHue(topicId)} 70% 45%)`;

/** Most recently active first. */
export const sortTopics = (topics: Record<string, Topic> | undefined): Topic[] => Object.values(topics ?? {}).sort((a, b) => b.lastSeq - a.lastSeq);
