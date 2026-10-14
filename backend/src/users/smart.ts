import { z } from "zod";

/**
 * The six smart features. Each person can switch any of them off for themselves
 * (Settings > Smart features). The three in LLM_FEATURES also need the group's
 * admin to have enabled them for that group, and the server to have an API key.
 */
export const SMART_FEATURES = ["lanes", "topicMute", "search", "catchUp", "status", "inbox"] as const;
export type SmartFeature = (typeof SMART_FEATURES)[number];
export type SmartSettings = Record<SmartFeature, boolean>;

export const LLM_FEATURES = ["catchUp", "status", "inbox"] as const satisfies readonly SmartFeature[];

/** Stored as a sparse JSON object; anything not stored is on. */
export function smartOf(stored: unknown): SmartSettings {
  const s = (stored ?? {}) as Partial<Record<SmartFeature, unknown>>;
  return Object.fromEntries(SMART_FEATURES.map((f) => [f, s[f] !== false])) as SmartSettings;
}

export const smartPatchSchema = z.object(Object.fromEntries(SMART_FEATURES.map((f) => [f, z.boolean().optional()])) as Record<SmartFeature, z.ZodOptional<z.ZodBoolean>>).strict();
