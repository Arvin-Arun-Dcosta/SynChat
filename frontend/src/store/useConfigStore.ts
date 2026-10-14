import { create } from "zustand";
import { api } from "../lib/api";

interface Features {
  imageUpload: boolean;
  /** The server has an AI provider key, so the LLM-backed features can be offered. */
  llm: boolean;
  /** The server can send web push notifications. */
  push: boolean;
}

interface ConfigState {
  features: Features;
  /** Who the server sends messages to for the AI features ("Google", "Anthropic"), when it has one. */
  aiProvider: string | null;
  vapidPublicKey: string | null;
  /** Resolves once the server's capabilities are known. Safe to call repeatedly. */
  load: () => Promise<void>;
}

let loading: Promise<void> | null = null;

/** What the server we are talking to can do. Anything it cannot do is hidden. */
export const useConfigStore = create<ConfigState>((set) => ({
  features: { imageUpload: false, llm: false, push: false },
  aiProvider: null,
  vapidPublicKey: null,
  load: () =>
    (loading ??= api
      .get<{ features: Partial<Features>; aiProvider?: string | null; vapidPublicKey?: string | null }>("/config")
      .then(({ data }) =>
        set({
          features: { imageUpload: Boolean(data.features.imageUpload), llm: Boolean(data.features.llm), push: Boolean(data.features.push) },
          aiProvider: typeof data.aiProvider === "string" ? data.aiProvider : null,
          vapidPublicKey: data.vapidPublicKey ?? null,
        }),
      )
      .catch(() => {
        loading = null; // keep the conservative defaults and allow another try
      })),
}));
