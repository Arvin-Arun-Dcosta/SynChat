import toast from "react-hot-toast";
import { create } from "zustand";
import { api, errorMessage, statusOf } from "../lib/api";
import { connectSocket, disconnectSocket } from "../lib/socket";
import type { Me } from "../types";
import { useChatStore } from "./useChatStore";

interface AuthState {
  user: Me | null;
  /** True until the first "am I signed in?" check has finished. */
  checking: boolean;
  busy: boolean;
  checkAuth: () => Promise<void>;
  signup: (data: { email: string; username: string; fullName: string; password: string }) => Promise<void>;
  login: (data: { identifier: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: Me) => void;
}

function begin(user: Me) {
  useAuthStore.setState({ user });
  connectSocket();
  void useChatStore.getState().loadConversations().catch(() => {});
}

function end() {
  disconnectSocket();
  useChatStore.getState().reset();
  useAuthStore.setState({ user: null });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  checking: true,
  busy: false,

  checkAuth: async () => {
    try {
      const { data } = await api.get<{ user: Me }>("/auth/me");
      if (get().user?.id !== data.user.id) begin(data.user);
      else set({ user: data.user });
    } catch (err) {
      // Only a definite "no" signs the user out; a network blip must not.
      if (statusOf(err) === 401 && get().user) end();
    } finally {
      set({ checking: false });
    }
  },

  signup: async (input) => {
    set({ busy: true });
    try {
      const { data } = await api.post<{ user: Me }>("/auth/signup", input);
      begin(data.user);
      toast.success("Welcome to SynChat");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      set({ busy: false });
    }
  },

  login: async (input) => {
    set({ busy: true });
    try {
      const { data } = await api.post<{ user: Me }>("/auth/login", input);
      begin(data.user);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      set({ busy: false });
    }
  },

  logout: async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* the session may already be gone; sign out locally regardless */
    }
    end();
  },

  setUser: (user) => set({ user }),
}));

// Any API call answering 401 means the session ended (expired, or signed out elsewhere).
api.interceptors.response.use(undefined, (err) => {
  const url: string = err?.config?.url ?? "";
  if (statusOf(err) === 401 && useAuthStore.getState().user && !url.startsWith("/auth/")) end();
  return Promise.reject(err);
});
