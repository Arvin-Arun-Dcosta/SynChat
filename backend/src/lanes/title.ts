const MAX_TITLE = 48;
const LEAD_IN = /^(?:(?:hey|hi|hello|yo|guys|everyone|all|btw|also|ok so|so|okay so|quick question|question|arre|suno|accha|acha|waise)(?:[\s,!:.-]+|$))+/i;

/**
 * A topic title made from a message, with no model: the message itself, minus
 * greetings, mentions and links, cut at a word boundary. Returns null when nothing
 * readable is left (e.g. "hey guys"), so the caller can wait for a better message.
 */
export function titleFromText(raw: string | null | undefined): string | null {
  let text = (raw ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@[\w.]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(LEAD_IN, "").trim();
  text = (text.split(/(?<=[.!?])\s|\n/)[0] ?? "").trim();
  text = text.replace(/[\s.,;:!-]+$/, "");
  if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return null;
  if (text.length > MAX_TITLE) {
    const cut = text.slice(0, MAX_TITLE + 1);
    text = cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : MAX_TITLE).replace(/[\s.,;:!-]+$/, "") + "…";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const FALLBACK_TITLE = "New topic";
