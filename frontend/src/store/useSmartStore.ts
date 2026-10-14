import toast from "react-hot-toast";
import { api, errorMessage } from "../lib/api";
import type { Me, SmartFeature } from "../types";
import { useAuthStore } from "./useAuthStore";
import { useConfigStore } from "./useConfigStore";

/** Is this smart feature switched on for the signed-in person? */
export const useSmart = (feature: SmartFeature): boolean => useAuthStore((s) => s.user?.smart[feature] ?? true);

/** Read outside React (in store actions). */
export const smartNow = (feature: SmartFeature): boolean => useAuthStore.getState().user?.smart[feature] ?? true;

let inFlight = 0;

/** Switch a smart feature on or off for myself. Applies at once and syncs to my other devices. */
export async function setSmart(feature: SmartFeature, on: boolean): Promise<void> {
  const { user, setUser } = useAuthStore.getState();
  if (!user) return;
  setUser({ ...user, smart: { ...user.smart, [feature]: on } });
  inFlight++;
  try {
    const { data } = await api.patch<{ user: Me }>("/auth/smart", { [feature]: on });
    // With several switches flipped in a row, an earlier answer does not yet include
    // the later ones. Only the answer to the last request is the whole truth.
    if (--inFlight === 0) setUser(data.user);
  } catch (err) {
    inFlight--;
    const now = useAuthStore.getState().user;
    if (now) setUser({ ...now, smart: { ...now.smart, [feature]: !on } });
    toast.error(errorMessage(err));
  }
}

/**
 * Is one of the three LLM-backed features available in this conversation? It takes
 * all of: the server has an AI provider configured, the group's admin has turned AI
 * on for the group, and I have not switched the feature off for myself.
 */
export function useAi(feature: "catchUp" | "status" | "inbox", conversation: { aiEnabled: boolean } | undefined): boolean {
  const configured = useConfigStore((s) => s.features.llm);
  const mine = useSmart(feature);
  return configured && mine && Boolean(conversation?.aiEnabled);
}

/** True while a settings change of mine is still on its way to the server. */
export const settingsBusy = () => inFlight > 0;
