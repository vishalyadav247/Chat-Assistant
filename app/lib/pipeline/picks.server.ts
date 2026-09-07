// Model picks (buy lane, 2026-09-01). The reply model sees up to 8 grounded
// candidates, each with an id, and starts its answer with ONE line —
// `PICKS: 3, 1` or `PICKS: none` — naming the ones that genuinely fit. Code
// turns that line into cards (ids validated against the allow-list; titles and
// prices still come from DB rows) and strips it from the shopper-visible text.
// No extra LLM call: the picks ride the generation call, so a buy turn still
// costs router + reply.
//
// Everything here is defensive by design: a missing or unparseable line means
// "no opinion", and the caller falls back to the mechanical relevance tier —
// a model that ignores the format degrades to the pre-picks behaviour, never
// to a broken reply. Retrieval stays the grounding: the model can only choose
// among rows code already fetched, never add one.

export type Picks = { kind: "ids"; ids: number[] } | { kind: "none" };

/** `PICKS: …` with optional markdown noise around the keyword. */
const PICKS_LINE = /^[\s*#>_-]*picks?\b[\s*_]*(?:[:=-]+[\s*_]*)?(.*)$/i;
const PICKS_SEPARATOR = /^[\s*#>_-]*picks?\b[\s*_]*[:=-]/i;
const NONE_BODY = /^(none|nothing|no|n\/a|nil|null|0|-)?[.!]?$/i;
const IDS_ONLY_BODY = /^[\d\s,;.&]*(and[\d\s,;.&]*)?$/i;

/**
 * Parse one line of model output. `null` = not a picks line at all (leave the
 * text alone). Ids are 1-based, deduplicated, in the model's order; range
 * checking against the allow-list is the caller's job.
 */
export function parsePicksLine(line: string): Picks | null {
  const trimmed = line.trim();
  const match = PICKS_LINE.exec(trimmed);
  if (!match) return null;
  const body = match[1].replace(/[*_`[\]()]/g, "").trim();
  // Without a separator ("Pick 2 of our bracelets…") only a bare id list or a
  // bare none-word counts — ordinary prose that happens to start with "Pick"
  // must survive untouched.
  const separated = PICKS_SEPARATOR.test(trimmed);
  if (NONE_BODY.test(body)) return separated || body.length > 0 ? { kind: "none" } : null;
  if (!separated && !IDS_ONLY_BODY.test(body)) return null;
  const ids: number[] = [];
  for (const m of body.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n > 0 && !ids.includes(n)) ids.push(n);
  }
  return ids.length > 0 ? { kind: "ids", ids } : null;
}

export interface PicksStream {
  /** The shopper-visible text: the source stream minus the picks line. */
  text: AsyncIterable<string>;
  /** Valid once `text` has been fully consumed. */
  result(): { picks: Picks | null; line: string | null };
}

export interface LeadingLineStream<T> {
  /** The shopper-visible text: the source stream minus the control line. */
  text: AsyncIterable<string>;
  /** Valid once `text` has been fully consumed. */
  result(): { parsed: T | null; line: string | null };
}

/** Longest a first line may grow (chars) before it is treated as prose. */
const MAX_FIRST_LINE = 80;

/**
 * Wrap a token stream: buffer the first line, consume it if `parse` claims it,
 * pass everything else through unchanged. The delay before the first visible
 * token is the control line itself (~10 tokens); a reply that opens with prose
 * is flushed as soon as its first line ends or MAX_FIRST_LINE is reached.
 *
 * Generic since 2026-09-04: the buy lane's `PICKS:` line and the support
 * lanes' `ACTION:` line (actions.server.ts) are the same trick, and one
 * carefully-tested buffering loop is worth more than two.
 */
export function splitLeadingLine<T>(
  source: AsyncIterable<string>,
  parse: (line: string) => T | null,
): LeadingLineStream<T> {
  let parsed: T | null = null;
  let line: string | null = null;

  async function* text(): AsyncIterable<string> {
    let buffer = "";
    let decided = false;
    let skipLeading = false;
    for await (const token of source) {
      if (decided) {
        if (skipLeading) {
          // Blank lines between the picks line and the prose never reach the widget.
          const trimmed = token.replace(/^\s+/, "");
          if (!trimmed) continue;
          skipLeading = false;
          yield trimmed;
        } else {
          yield token;
        }
        continue;
      }
      buffer += token;
      const nl = buffer.indexOf("\n");
      if (nl < 0 && buffer.length < MAX_FIRST_LINE) continue;
      decided = true;
      const hit = nl >= 0 ? parse(buffer.slice(0, nl)) : null;
      if (hit !== null) {
        parsed = hit;
        line = buffer.slice(0, nl).trim();
        const rest = buffer.slice(nl + 1).replace(/^\s+/, "");
        if (rest) yield rest;
        else skipLeading = true;
      } else {
        yield buffer;
      }
      buffer = "";
    }
    if (!decided && buffer) {
      // Stream ended inside the first line: a lone control line (no prose) or a
      // one-line reply.
      const hit = parse(buffer);
      if (hit !== null) {
        parsed = hit;
        line = buffer.trim();
      } else {
        yield buffer;
      }
    }
  }

  return { text: text(), result: () => ({ parsed, line }) };
}

/** The buy lane's `PICKS:` line. Thin wrapper over splitLeadingLine so the
 *  call site keeps reading in the vocabulary of what it is doing. */
export function splitPicksStream(source: AsyncIterable<string>): PicksStream {
  const split = splitLeadingLine(source, parsePicksLine);
  return {
    text: split.text,
    result: () => {
      const { parsed, line } = split.result();
      return { picks: parsed, line };
    },
  };
}
