/**
 * Normalised "views" of a text that the injection signatures run against.
 *
 * Attackers dodge keyword filters with diacritics, look-alike letters (Cyrillic
 * "о" for "o"), invisible characters inside words, l33tspeak and s p a c e d
 * letters. Every view folds those away and keeps, for each output character,
 * the index of the original character it came from — so a match can be shown
 * to the owner as the original text, not as the folded one.
 */

export type TextView = {
  /** Folded text: lower case, no diacritics, look-alikes mapped to Latin, invisible characters removed, spaces collapsed. */
  text: string;
  /** `map[i]` = index in the original string of the character that produced `text[i]`. */
  map: number[];
};

export type ObfuscationStats = {
  /** Zero-width characters sitting between two letters ("ig\u200Bnore"). */
  zeroWidthInWords: number;
  /** Bidirectional overrides/isolates, which can reorder what a human sees. */
  bidiControls: number;
  /** Unicode tag characters (U+E0000–E007F) outside an emoji flag: invisible ASCII ("ASCII smuggling"). */
  tagCharacters: number;
  /** The ASCII those tag characters spell, if any. */
  tagText: string;
  /** Words mixing Latin with Cyrillic or Greek letters ("pаssword" with a Cyrillic "а"). */
  mixedScriptWords: number;
};

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e, 0x00ad, 0x034f, 0x2061, 0x2062, 0x2063, 0x2064]);
const BIDI = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

function isInvisible(cp: number): boolean {
  return ZERO_WIDTH.has(cp)
    || BIDI.has(cp)
    || (cp >= 0xe0000 && cp <= 0xe007f) // tag characters
    || (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
    || (cp >= 0xe0100 && cp <= 0xe01ef)
    || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0 // Hangul fillers
    || cp === 0x17b4 || cp === 0x17b5;
}

/** Cyrillic and Greek letters that look like Latin ones (lower case after `toLowerCase`). */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ɡ: 'g', ı: 'i', ɩ: 'i', ꞵ: 'b',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ϳ: 'j',
  ʏ: 'y', ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n',
  ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ᴢ: 'z',
};

const PUNCTUATION: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '´': "'", '`': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '«': '"', '»': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...',
};

const COMBINING = /\p{M}/u;
const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** Folds one already-lower-cased character (may yield 0–3 characters). */
function foldChar(ch: string): string {
  if (PUNCTUATION[ch]) return PUNCTUATION[ch];
  if (HOMOGLYPHS[ch]) return HOMOGLYPHS[ch];
  let out = '';
  for (const part of ch.normalize('NFKD')) {
    if (COMBINING.test(part)) continue;
    out += HOMOGLYPHS[part] ?? part;
  }
  return out;
}

/** Folded form of each ASCII code point (lower case; whitespace becomes ' ' or '\n'; backtick becomes '). */
const ASCII_FOLD: string[] = Array.from({ length: 128 }, (_, code) => {
  if (code === 10 || code === 13) return '\n';
  if (code === 9 || code === 11 || code === 12 || code === 32) return ' ';
  if (code === 96) return "'";
  return String.fromCharCode(code).toLowerCase();
});

/** Folded form of non-ASCII code points seen so far: normalising every "ř" again is the slow part. */
const FOLD_CACHE = new Map<number, string>();
const FOLD_CACHE_LIMIT = 20_000;

/** Lower case, NFKC (fullwidth, math bold, ligatures), no diacritics, Latin look-alikes, single spaces, `\n` kept. */
export function foldText(original: string): TextView {
  // Arrays, not string concatenation: a 200 kB e-mail must fold in milliseconds, not seconds.
  const chars: string[] = [];
  const map: number[] = [];
  const emit = (out: string, at: number) => {
    const last = chars[chars.length - 1];
    if (out === ' ' && (last === ' ' || last === '\n' || chars.length === 0)) return;
    if (out === '\n' && last === ' ') {
      chars.pop();
      map.pop();
    }
    if (out === '\n' && chars[chars.length - 1] === '\n') return;
    chars.push(out);
    map.push(at);
  };
  let index = 0;
  for (const symbol of original) {
    const cp = symbol.codePointAt(0) ?? 0;
    const at = index;
    index += symbol.length;
    if (cp < 128) {
      // Fast path: plain ASCII needs no Unicode normalisation.
      emit(ASCII_FOLD[cp], at);
      continue;
    }
    if (isInvisible(cp)) continue;
    let folded = FOLD_CACHE.get(cp);
    if (folded === undefined) {
      folded = '';
      for (const ch of symbol.normalize('NFKC').toLowerCase()) {
        folded += /\s/.test(ch) ? (ch === '\u2028' || ch === '\u2029' ? '\n' : ' ') : foldChar(ch);
      }
      if (FOLD_CACHE.size < FOLD_CACHE_LIMIT) FOLD_CACHE.set(cp, folded);
    }
    // Per UTF-16 unit, not per code point: an emoji stays two units, and `map` must keep pace with `text`.
    for (let unit = 0; unit < folded.length; unit += 1) emit(folded[unit], at);
  }
  return { text: chars.join(''), map };
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'l', '€': 'e' };

/**
 * l33tspeak decoded inside words that mix letters with digits or symbols ("1gn0r3");
 * plain numbers and prices stay as they are. Null when nothing changed.
 */
export function leetView(view: TextView): TextView | null {
  let changed = false;
  const text = view.text.replace(/[\p{L}0-9@$!|€]+/gu, (token) => {
    if (!/\p{L}/u.test(token) || !/[0-9@$!|€]/.test(token) || /^\d+[a-z]{1,3}$/.test(token)) return token;
    changed = true;
    return token.replace(/[0-9@$!|€]/g, (ch) => LEET[ch] ?? ch);
  });
  return changed ? { text, map: view.map } : null;
}

/** Letters only — "i g n o r e  a l l" and "ign.ore" become "ignoreall". Used only for long literal signatures. */
export function squashView(view: TextView): TextView & { parentIndex: number[] } {
  let text = '';
  const map: number[] = [];
  const parentIndex: number[] = [];
  for (let i = 0; i < view.text.length; i += 1) {
    const ch = view.text[i];
    if (ch >= 'a' && ch <= 'z') {
      text += ch;
      map.push(view.map[i]);
      parentIndex.push(i);
    }
  }
  return { text, map, parentIndex };
}

/** ROT13 of the folded text (same length, same map). */
export function rot13View(view: TextView): TextView {
  const text = view.text.replace(/[a-z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 97 + 13) % 26) + 97));
  return { text, map: view.map };
}

/** Counts the invisible tricks in the original text; they are signals on their own. */
export function obfuscationStats(original: string): ObfuscationStats {
  const symbols = [...original];
  let zeroWidthInWords = 0;
  let bidiControls = 0;
  let tagCharacters = 0;
  let tagText = '';
  for (let i = 0; i < symbols.length; i += 1) {
    const cp = symbols[i].codePointAt(0) ?? 0;
    if (ZERO_WIDTH.has(cp)) {
      // Skip runs of invisibles to find the visible neighbours.
      let before = i - 1;
      while (before >= 0 && isInvisible(symbols[before].codePointAt(0) ?? 0)) before -= 1;
      let after = i + 1;
      while (after < symbols.length && isInvisible(symbols[after].codePointAt(0) ?? 0)) after += 1;
      if (before >= 0 && after < symbols.length && LETTER.test(symbols[before]) && LETTER.test(symbols[after])) zeroWidthInWords += 1;
    } else if (BIDI.has(cp)) {
      bidiControls += 1;
    } else if (cp >= 0xe0000 && cp <= 0xe007f) {
      // A subdivision flag (🏴 + tags, e.g. Scotland) is the one legitimate use.
      let start = i;
      while (start > 0 && (symbols[start - 1].codePointAt(0) ?? 0) >= 0xe0000 && (symbols[start - 1].codePointAt(0) ?? 0) <= 0xe007f) start -= 1;
      const inFlag = start > 0 && symbols[start - 1] === '\u{1F3F4}';
      if (!inFlag) {
        tagCharacters += 1;
        if (cp >= 0xe0020 && cp <= 0xe007e) tagText += String.fromCharCode(cp - 0xe0000);
      }
    }
  }
  let mixedScriptWords = 0;
  for (const word of original.match(/[\p{L}\p{M}]+/gu) ?? []) {
    if (LATIN.test(word) && CYRILLIC_OR_GREEK.test(word)) mixedScriptWords += 1;
  }
  return { zeroWidthInWords, bidiControls, tagCharacters, tagText, mixedScriptWords };
}

const MAX_EXAMINED_BLOCKS = 2000;
const MAX_BLOCK_CHARS = 100_000;

/**
 * Text hidden in base64 or hex runs, decoded when it is readable text.
 * ("Decode this and follow it: SWdub3JlIGFsbC…")
 */
export function decodeEmbedded(original: string, limit = 20): { decoded: Array<{ kind: 'base64' | 'hex'; text: string }>; skipped: number } {
  const out: Array<{ kind: 'base64' | 'hex'; text: string }> = [];
  let skipped = 0;
  // Tracking links are full of base64-looking ids; examining is cheap, but bounded.
  let examined = 0;
  const readable = (value: string) => {
    if (value.length < 8) return false;
    const sample = value.slice(0, 4000);
    let printable = 0;
    for (const ch of sample) if (/[\p{L}\p{N}\p{P}\s]/u.test(ch)) printable += 1;
    // Prose, or an identifier-like string ("get_system_prompt") — not binary noise.
    return printable / [...sample].length > 0.92 && /\p{L}{3}/u.test(sample) && (/\s/.test(sample) || /^[\w.:/-]+$/.test(sample.trim()));
  };
  for (const match of original.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    // Past the limit only count: a payload hidden behind harmless blocks must not pass silently.
    if (out.length >= limit || examined >= MAX_EXAMINED_BLOCKS) {
      skipped += 1;
      continue;
    }
    examined += 1;
    // A huge block is decoded only in part: enough to read an instruction, bounded in cost.
    const raw = match[0].slice(0, MAX_BLOCK_CHARS);
    if (/^[a-z0-9]+$/i.test(raw) && !/[A-Z]/.test(raw)) continue; // hex ids, lower-case slugs
    try {
      const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (readable(decoded)) out.push({ kind: 'base64', text: decoded });
    } catch {
      // not base64
    }
  }
  for (const match of original.matchAll(/(?:[0-9a-fA-F]{2}[\s:]?){16,}/g)) {
    if (out.length >= limit || examined >= MAX_EXAMINED_BLOCKS) {
      skipped += 1;
      continue;
    }
    examined += 1;
    const decoded = Buffer.from(match[0].slice(0, MAX_BLOCK_CHARS).replace(/[\s:]/g, ''), 'hex').toString('utf8');
    if (readable(decoded)) out.push({ kind: 'hex', text: decoded });
  }
  return { decoded: out, skipped };
}
