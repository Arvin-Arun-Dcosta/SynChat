import axios, { AxiosError } from "axios";

// Same origin by default: Vite proxies /api in development and the backend serves
// the built app in production. VITE_API_URL names the backend's origin only when
// the built app is hosted somewhere else.
export const API_ORIGIN = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export const api = axios.create({ baseURL: `${API_ORIGIN}/api`, withCredentials: true, timeout: 20_000 });

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: { fieldErrors?: Record<string, string[]> } };
}

/** A sentence a person can read, from whatever went wrong with a request. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof AxiosError) {
    const body = err.response?.data as ApiErrorBody | undefined;
    const fieldErrors = body?.error?.details?.fieldErrors;
    const firstField = fieldErrors && Object.values(fieldErrors).flat()[0];
    if (firstField) return firstField;
    if (body?.error?.message) return body.error.message;
    if (!err.response) return "Can't reach the server. Check your connection.";
  }
  return fallback;
}

export const statusOf = (err: unknown): number | undefined => (err instanceof AxiosError ? err.response?.status : undefined);

/** Worth retrying unchanged: the network failed or the server had a problem. */
export function isTransient(err: unknown): boolean {
  const status = statusOf(err);
  return status === undefined || status >= 500 || status === 429;
}
