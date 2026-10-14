/**
 * Cheap, language-light reading of one chat message. No model involved: this is what
 * tells the assigner how much to trust the embedding ("ok" carries no topic at all)
 * and what conversational role the message plays (question, answer, reaction).
 */

// Words that carry no topic. English plus the Hindi/Hinglish fillers our users mix in.
const FILLER = new Set(
  (
    "a an the this that these those it its i im i'm me my we our us you your u ur he she they them his her their " +
    "is are am was were be been being do does did done have has had having will would can could should shall may might must " +
    "and or but so if then than as at by for from in into of on onto to up out off over with without about " +
    "not no nope nah yes yeah yep yup ya ok okay okk k kk sure fine cool nice great good right alright " +
    "lol lmao lmfao rofl haha hahaha hehe hmm hm oh ah uh um wow damn omg wtf thx thanks thank ty pls please plz " +
    "what when where who whom which why how there here now just too very really also still yet again well like " +
    "hey hi hello yo sup guys all everyone anybody anyone someone somebody " +
    // Time words say when, not what about: "friday" matches "saturday" in any topic.
    "today tomorrow tonight yesterday morning afternoon evening night day days time later soon monday tuesday wednesday thursday friday saturday sunday " +
    "actually maybe probably though tho wait already ever never always lot bit much many some any more most other one two " +
    "get got go going gonna come coming make made take took see saw know think thought want need let lets say said tell told " +
    "kal aaj abhi raat subah shaam baje " +
    // Contractions and the rest of the usual function words.
    "i'll i've i'd you're you'll you've you'd he's she's it's we're we'll we've we'd they're they'll they've they'd that's there's here's what's who's where's " +
    "let's don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't couldn't shouldn't haven't hasn't hadn't ain't " +
    "dont doesnt didnt isnt arent wasnt werent wont wouldnt cant couldnt shouldnt havent hasnt hadnt im ive ill youre thats whats lets " +
    "after before because since until while during between both each few own same such only than through under above below down " +
    "mine yours ours theirs myself yourself itself him himself herself themselves anything something nothing everything else another " +
    "been being having doing does did had has able about across against along around away back even every far put use used using " +
    "least last next first then once twice way thing things stuff kind sort " +
    "haan han ha nahi nai na kya kyu kyun kaise kab kaun hai hain ho hu hoon tha thi the toh to bhi hi ko ka ki ke se me mein par pe " +
    "yaar bhai bro dude acha accha achha theek thik sahi arre are abe matlab bas ab phir fir aur ya"
  ).split(/\s+/),
);

const REACTION = /^(?:l+o+l+|lmf?ao+|rofl|(?:ha|he|hi){2,}h?|hah|heh|xd+|ikr|omg+|wow+|damn+|nice+|oof+|yikes|true|same|fr|facts|rip|aww+|ew+|ugh+|yay+|woo+h?o*|noo+|yess+|bruh+|wtf|sheesh)$/;
const ANSWER_START = /^(?:yes|yeah|yep|yup|ya|no|not|nope|nah|ok|okay|k|sure|fine|maybe|probably|idk|dunno|done|agreed|works|sounds|same|me|both|neither|either|can't|cant|cannot|sent|paid|noted|deal|true|exactly|right|correct|thanks|thank|thx|ty|haan|han|nahi|nai|theek|thik|sahi|chalega|pakka|bilkul)$/;
const NEW_TOPIC_CUE = /^(?:btw|by the way|also|anyway|anyways|unrelated|random|quick question|quick q|question|side note|on another note|changing topic|different topic|ps|fyi|reminder|heads up|waise|ek aur baat|accha suno|suno)\b/;
const QUESTION_WORD = /^(?:who|what|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|should|would|will|has|have|anyone|anybody|any|kya|kab|kaun|kaise|kahan|kidhar|kitne|kitna|kitni|kyu|kyun)$/;
const HINDI_QUESTION_WORD = /^(?:kya|kab|kaun|kaunsa|kaunsi|kaise|kaisa|kahan|kidhar|kitne|kitna|kitni|kyu|kyun|kyon|kiski|kiska|kiske|kisne|kisko|kis)$/;
const LEAD_IN = new Set("btw also so ok okay and but hey hi yo guys anyway anyways wait oh hmm well waise arre accha acha suno yaar bhai".split(" "));
const WH_WORD = /^(?:what|when|where|which|who|whose|why|how)$/;
const QUANTITY_QUESTION = /\b(?:when|what time|how many|how much|how long|what day|which day|what date|kab|kitne|kitna|kitni|kitne baje|kis time)\b/;
const NUMBER = /(?:^|[^a-z])\d{1,4}(?::\d{2})?\s?(?:am|pm|ish|baje|mins?|hrs?|k)?\b/;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s!?.]+$/u;

/**
 * Spellings to look a word up under: people stretch words ("nooo", "okkk", "ohh").
 * Runs of three or more letters are cut to two, and a doubled letter is also tried single.
 */
function variants(token: string): string[] {
  const two = token.replace(/(.)\1{2,}/gu, "$1$1");
  const one = two.replace(/(.)\1/gu, "$1");
  return one === two ? [two] : [two, one];
}
const isFiller = (t: string) => variants(t).some((v) => FILLER.has(v));
const isReactionWord = (t: string) => variants(t).some((v) => REACTION.test(v));

/** The form of a content word used for matching: lowercased, plural "s" dropped. */
const stem = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

export interface TextFeatures {
  tokens: string[];
  /** Distinct words that say what the message is about (not filler), stemmed. */
  content: string[];
  /** Number of content words. */
  contentCount: number;
  isQuestion: boolean;
  /** Laughter, an interjection or emoji only: a reaction to something just said. */
  isReaction: boolean;
  /** Opens like an answer ("yes", "ok", "8 works"). */
  isAnswerLike: boolean;
  hasNumber: boolean;
  /** Opens with a phrase people use to change the subject ("btw", "also", "quick question"). */
  hasNewTopicCue: boolean;
  /** A question about a time or an amount, which a bare number can answer. */
  asksQuantity: boolean;
}

export function analyseText(raw: string | null | undefined): TextFeatures {
  const text = (raw ?? "").toLowerCase().replace(/https?:\/\/\S+/g, " url ").trim();
  const tokens = text.match(WORD) ?? [];
  // A bare number says little, except model numbers and years ("4060", "2024").
  const content = [...new Set(tokens.filter((t) => t.length > 1 && !isFiller(t) && !isReactionWord(t) && (!/^\d+$/.test(t) || t.length >= 3)).map(stem))];
  const contentCount = content.length;
  // The first word that is not just a lead-in: "btw is the wifi down" opens with "is".
  const first = tokens.find((t) => !LEAD_IN.has(t)) ?? tokens[0] ?? "";
  const hasNumber = NUMBER.test(text);
  const isReaction =
    tokens.length === 0
      ? text.length > 0 && EMOJI_ONLY.test(text)
      : tokens.length <= 3 && tokens.every((t) => isReactionWord(t) || isFiller(t)) && (tokens.some(isReactionWord) || contentCount === 0);
  const firstIsAnswer = variants(first).some((v) => ANSWER_START.test(v));
  // "no idea what he means" is not a question; "me! where though" is.
  const firstIsAnswerOnly = /^(?:no|nope|not|idk|dunno)$/.test(first);
  // Questions are often typed without a question mark, and in Hindi the question word
  // comes mid-sentence ("jaipur kaise ja rahe hain"). "X or Y" / "X ya Y" asks too.
  const isQuestion =
    text.includes("?") ||
    (tokens.length >= 2 && QUESTION_WORD.test(first) && !firstIsAnswer) ||
    (tokens.length >= 2 && tokens.some((t) => HINDI_QUESTION_WORD.test(t))) ||
    // A short message with a wh-word anywhere: "me! where though", "ok 14th. which hall".
    (tokens.length >= 2 && tokens.length <= 6 && !firstIsAnswerOnly && tokens.some((t) => WH_WORD.test(t))) ||
    (tokens.length >= 3 && tokens.length <= 7 && tokens.slice(1, -1).some((t) => t === "or" || t === "ya"));
  return {
    tokens,
    content,
    contentCount,
    isQuestion,
    isReaction,
    isAnswerLike: firstIsAnswer || (hasNumber && tokens.length <= 4),
    hasNumber,
    hasNewTopicCue: NEW_TOPIC_CUE.test(text),
    asksQuantity: isQuestion && QUANTITY_QUESTION.test(text),
  };
}

/** 0 for a message with no topical content ("ok", "lol"), 1 once it has `fullAt` content words. */
export function infoOf(f: TextFeatures, fullAt: number): number {
  if (f.isReaction) return 0;
  return Math.min(1, f.contentCount / fullAt);
}

export interface Person {
  id: string;
  /** Lowercased handles this person answers to: username, first name. */
  names: string[];
}

/**
 * Who a message is spoken to, judged from names in its text: "@ben", "ben: ...",
 * "ben, ..." or just "thanks ben". Only people already in the conversation count.
 */
export function addresseesOf(raw: string | null | undefined, senderId: string, people: Person[]): string[] {
  const text = (raw ?? "").toLowerCase();
  if (!text || people.length === 0) return [];
  const words = new Set(text.match(/@?[\p{L}\p{N}_.\-[\]{}|^`\\]+/gu)?.map((w) => w.replace(/^@/, "").replace(/[.,:;!?]+$/, "")) ?? []);
  const found: string[] = [];
  for (const p of people) {
    if (p.id === senderId) continue;
    if (p.names.some((n) => n.length >= 3 && words.has(n))) found.push(p.id);
  }
  return found;
}
