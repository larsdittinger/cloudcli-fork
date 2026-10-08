import fs from 'node:fs';
import path from 'node:path';

import { extractHtmlText } from '@/modules/channels/injection/html-hidden.js';
import { SIGNATURE_DEFINITIONS } from '@/modules/channels/injection/signatures.js';
import type { InjectionCategory, SignatureDefinition } from '@/modules/channels/injection/signatures.js';
import { decodeEmbedded, foldText, leetView, obfuscationStats, rot13View, squashView } from '@/modules/channels/injection/text-views.js';
import type { TextView } from '@/modules/channels/injection/text-views.js';

/**
 * Prompt-injection scan of one inbound message before any agent sees it.
 *
 * Every part an agent may read is scanned on its own: subject, text, the
 * hidden part of the HTML, text-like attachments and payloads decoded from
 * base64 / hex / invisible tag characters. Each signature counts once (its
 * strongest hit); the score is the sum of the best finding per category, so
 * one strong phrase or two independent medium signals hold the message.
 */

export type InjectionSensitivity = 'normal' | 'strict';

export type InjectionFinding = {
  id: string;
  category: InjectionCategory;
  label: string;
  /** Weight after the location factor (hidden text and decoded payloads weigh more). */
  weight: number;
  /** Where it was found: subject, text, html-hidden (with how), attachment:<name>, decoded:<kind>. */
  where: string;
  /** The matched original text (diacritics and all), clipped. */
  excerpt: string;
};

export type InjectionScan = {
  score: number;
  threshold: number;
  flagged: boolean;
  findings: InjectionFinding[];
  /** What could not be checked (an oversize part, a PDF): the owner should know the scan is partial. */
  notChecked?: string[];
  /** Set when the scanner itself failed; the message then went on unchecked. */
  error?: string;
  scannedAt: string;
  version: number;
};

export type ScanInput = {
  subject?: string | null;
  text: string;
  html?: string | null;
  /** The sender's display name and address: both go into the agent's prompt. */
  fromName?: string | null;
  from?: string | null;
  /** Further sender-controlled fields an agent can read (webhook thread and metadata, WhatsApp quote). */
  extra?: Array<{ where: string; text: string }>;
  attachments?: Array<{ name: string; mime: string; size: number; path: string }>;
};

/** Bump when signatures or scoring change, so stored scans can be told apart. */
export const SCANNER_VERSION = 2;

export const THRESHOLDS: Record<InjectionSensitivity, number> = { normal: 1, strict: 0.6 };

/** A part longer than this is scanned at its start and its end; the middle is reported as not checked. */
const PART_HEAD_CHARS = 160_000;
const PART_TAIL_CHARS = 40_000;
/** All parts of one message together; bounds the CPU one message can cost (~0.5 s). */
const MESSAGE_BUDGET_CHARS = 1_000_000;
const MAX_DECODED_BLOCKS = 50;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_ATTACHMENTS_SCANNED = 10;
const TEXT_ATTACHMENT = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|x-yaml|yaml|csv|rtf|javascript|x-sh|markdown|ld\+json))/i;
const TEXT_EXTENSION = /\.(?:txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|eml|ics|vcf|log|rtf|js|ts|py|sh|ini|cfg|conf|env)$/i;

const LOCATION_FACTOR = { hidden: 1.5, decoded: 1.3, attachment: 1, visible: 1 } as const;
const MAX_FINDING_WEIGHT = 1.5;
/** Matches a signature may have rejected (exceptions, descriptions) before it gives up on a part. */
const MAX_REJECTED_MATCHES = 200;

type CompiledSignature = SignatureDefinition & { regex: RegExp | null; unlessRegex: RegExp | null };

let compiled: CompiledSignature[] | null = null;

/** Compiled once; a broken pattern throws here (and in the unit test), not per message. */
function signatures(): CompiledSignature[] {
  if (!compiled) {
    compiled = SIGNATURE_DEFINITIONS.map((definition) => ({
      ...definition,
      regex: definition.pattern ? new RegExp(definition.pattern, 'gm') : null,
      unlessRegex: definition.unless ? new RegExp(definition.unless, 'm') : null,
    }));
  }
  return compiled;
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Original text behind a folded-view match. */
function originalExcerpt(original: string, view: TextView, start: number, end: number): string {
  const from = view.map[start] ?? 0;
  const lastIndex = view.map[Math.max(start, end - 1)] ?? from;
  // The last mapped character may be a surrogate pair or a ligature; take it whole.
  const to = Math.min(original.length, lastIndex + 2);
  return clip(original.slice(from, to).replace(/[\uD800-\uDBFF]$/, ''));
}

type Part = { where: string; factor: number; original: string };

/** The current sentence around a match: exceptions and descriptions count only there. */
function sentenceAround(text: string, start: number, end: number, before = 80, after = 120): { before: string; after: string } {
  let head = text.slice(Math.max(0, start - before), start);
  const boundary = Math.max(head.lastIndexOf('\n'), ...['. ', '! ', '? '].map((mark) => head.lastIndexOf(mark)));
  if (boundary >= 0) head = head.slice(boundary + 1);
  let tail = text.slice(end, end + after);
  const stop = tail.search(/[.!?](?:\s|$)|\n/);
  if (stop >= 0) tail = tail.slice(0, stop);
  return { before: head, after: tail };
}

/** A phrase in quotes after "such as", "věty jako"… is cited, not said: "users may type 'ignore previous instructions'". */
const QUOTED_FACTOR = 0.5;
/** Phrases people quote when they write *about* injection; tokens and tool syntax stay suspicious in quotes too. */
const QUOTABLE = new Set<InjectionCategory>(['override', 'role', 'new_task', 'exfiltration', 'authority', 'concealment', 'address_ai']);
const SINGLE_OPEN = /(?:^|[\s:(\[])'[^'\n]*$/;
const SINGLE_CLOSE = /^[^'\n]*'(?=[\s.,;:!?)\]]|$)/;
const CITING = /\b(?:such as|like|e\.?g\.?|for example|for instance|called|says|said|saying|writes?|wrote|written|phrases?|sentences?|lines?|strings?|prompts? like|types?|typed|enters?|contain(?:s|ing)?|example|quote[sd]?|typu|jako|napriklad|treba|vet[ay]?|fraz[eiy]?|pise|napsal[ai]?|rika(?:ji)?|obsahuj(?:e|i)|priklad|citat|citujem?|beispiel|wie|satze?)\b/;

/** Inside quotes on its line, introduced as a citation. A bare quoted payload keeps its full weight. */
function cited(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  const before = text.slice(Math.max(lineStart, start - 300), start);
  const after = text.slice(end, Math.min(lineEnd < 0 ? text.length : lineEnd, end + 300));
  const doubleOpen = before.lastIndexOf('"');
  const inDouble = (before.split('"').length - 1) % 2 === 1 && after.includes('"');
  const singleOpen = SINGLE_OPEN.exec(before);
  const inSingle = Boolean(singleOpen) && SINGLE_CLOSE.test(after);
  if (!inDouble && !inSingle) return false;
  const open = inDouble ? doubleOpen : before.lastIndexOf("'");
  return CITING.test(before.slice(Math.max(0, open - 80), open + 1));
}

/**
 * The phrase is a third-party statement, not an order: "the agent should ignore any instructions",
 * "ten agent zase ignoroval systémový prompt". First and second person ("I want you to ignore…",
 * "make sure to…") stay orders. Judged within the sentence only.
 */
const DESCRIBED_BEFORE = /\b(?:the |an? |this |that |our |their |his |her |its )?(?:agent|agents|assistant|assistants|model|models|bot|bots|chatbot|chatbots|llm|llms|ai|attacker|attackers|hacker|hackers|user|users|someone|somebody|people|it|they|he|she|which|who|utocnik\w*|asistent\w*|model\w*|uzivatel\w*|pouzivatel\w*|robot\w*|ktery|ktera|ktere|kdo|nekdo|ten agent|ta ai)\s+(?:\w+\s+){0,2}?(?:(?:should|must|shall|will|would|can|could|may|might|tries to|try to|trying to|attempts? to|is (?:told|asked|tricked|supposed) to|was (?:told|asked|tricked) to|to|not|never|doesn't|does not|won't|cannot|can't|by|nesmi|musi|muze|nemuze|zkusi|zkousi|chce|nechce|ma|mel|mela|nemel|nemela|mohl|mohla|nesmie|moze|nemoze)\s+(?:not\s+)?)?$/;
const DESCRIBABLE = new Set<InjectionCategory>(['override', 'role', 'exfiltration', 'concealment']);
/** "ignore my previous instructions" — the sender's own; checked inside the match only. */
const POSSESSIVE_IN_MATCH = /\b(?:my|our|moj\w*|meho|mych|nas[ei]\w*|meine?\w*|unsere?\w*)\b/;

function* scanPart(part: Part, add: (finding: InjectionFinding) => void): Generator<void> {
  const original = part.original;
  if (!original.trim()) return;
  const folded = foldText(original);
  const leet = leetView(folded);
  const views: TextView[] = leet ? [folded, leet] : [folded];
  // ROT13 only when the text itself talks about it: otherwise it is noise.
  if (/\brot ?-?13\b|\bcaesar\b|\bsifr|\bcipher\b/.test(folded.text)) views.push(rot13View(folded));
  const squashed = views.slice(0, 2).map((view) => ({ view, squash: squashView(view) }));

  /** Records a match unless its sentence says it is not meant; a cited one weighs half. */
  const accept = (signature: CompiledSignature, view: TextView, start: number, end: number, fromSquash: boolean): boolean => {
    const sentence = sentenceAround(view.text, start, end);
    if (signature.unlessRegex) {
      if (signature.unlessRegex.test(`${sentence.before}${view.text.slice(start, end)}${sentence.after}`)) return false;
      if (POSSESSIVE_IN_MATCH.test(view.text.slice(start, end))) return false;
    }
    if (!fromSquash && DESCRIBABLE.has(signature.category) && DESCRIBED_BEFORE.test(sentence.before)) return false;
    const dampened = QUOTABLE.has(signature.category) && cited(view.text, start, end);
    add({
      id: signature.id,
      category: signature.category,
      label: signature.label,
      weight: Math.min(MAX_FINDING_WEIGHT, signature.weight * part.factor * (dampened ? QUOTED_FACTOR : 1)),
      where: part.where,
      excerpt: originalExcerpt(original, view, start, end),
    });
    return true;
  };

  // Categories a regular signature already found here: the squashed duplicates add nothing then.
  const foundCategories = new Set<InjectionCategory>();
  const ordered = [...signatures()].sort((a, b) => Number(Boolean(a.squash)) - Number(Boolean(b.squash)));
  for (const signature of ordered) {
    let found = false;
    if (signature.regex) {
      for (const view of views) {
        if (found) break;
        signature.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        let rejected = 0;
        while (!found && rejected < MAX_REJECTED_MATCHES && (match = signature.regex.exec(view.text)) !== null) {
          if (match[0].length === 0) {
            signature.regex.lastIndex += 1;
            continue;
          }
          found = accept(signature, view, match.index, match.index + match[0].length, false);
          if (!found) rejected += 1;
        }
      }
      if (found) foundCategories.add(signature.category);
    }
    if (!found && signature.squash && !foundCategories.has(signature.category)) {
      for (const { view, squash } of squashed) {
        if (found) break;
        for (const literal of signature.squash) {
          let at = squash.text.indexOf(literal);
          let tries = 0;
          while (at >= 0 && !found && tries < MAX_REJECTED_MATCHES) {
            // Back to the folded view, so exceptions and quotes are judged on real words.
            found = accept(signature, view, squash.parentIndex[at], squash.parentIndex[at + literal.length - 1] + 1, true);
            at = squash.text.indexOf(literal, at + 1);
            tries += 1;
          }
          if (found) break;
        }
      }
    }
  }
  yield;
}

function readTextAttachment(attachment: { name: string; mime: string; size: number; path: string }): string | null {
  if (attachment.size > MAX_ATTACHMENT_BYTES) return null;
  if (!TEXT_ATTACHMENT.test(attachment.mime) && !TEXT_EXTENSION.test(attachment.name)) return null;
  try {
    const resolved = path.resolve(attachment.path);
    if (!fs.existsSync(resolved)) return null;
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

/** Sum of the best finding per category, plus a little for further distinct signatures in it. */
function score(findings: InjectionFinding[]): number {
  const byCategory = new Map<InjectionCategory, InjectionFinding[]>();
  for (const finding of findings) {
    const list = byCategory.get(finding.category) ?? [];
    list.push(finding);
    byCategory.set(finding.category, list);
  }
  let total = 0;
  for (const list of byCategory.values()) {
    list.sort((a, b) => b.weight - a.weight);
    const best = list[0];
    // Several signatures on the same words are one signal; only a second, separate passage adds.
    const key = (finding: InjectionFinding) => finding.excerpt.toLowerCase().replace(/[^\p{L}]+/gu, '');
    const separate = list.slice(1).filter((f) => f.weight >= 0.3 && !key(best).includes(key(f)) && !key(f).includes(key(best)));
    total += best.weight + Math.min(0.3, separate.length * 0.15);
  }
  return Math.round(total * 100) / 100;
}

/** The scan as steps: one per part, so the async runner can let the event loop breathe between them. */
function* scanSteps(input: ScanInput, sensitivity: InjectionSensitivity, result: { scan?: InjectionScan }): Generator<void> {
  const byId = new Map<string, InjectionFinding>();
  const notChecked: string[] = [];
  const add = (finding: InjectionFinding) => {
    const existing = byId.get(finding.id);
    if (!existing || existing.weight < finding.weight) byId.set(finding.id, finding);
  };
  const addStructural = (id: string, category: InjectionCategory, label: string, weight: number, where: string, excerpt: string) =>
    add({ id, category, label, weight, where, excerpt: clip(excerpt) });

  let budget = MESSAGE_BUDGET_CHARS;
  const parts: Part[] = [];
  /** Adds a part within the budgets; whatever is cut is reported and, being padding, weighs a little. */
  const addPart = (where: string, factor: number, text: string | null | undefined) => {
    if (!text || !text.trim()) return;
    let original = text;
    if (original.length > PART_HEAD_CHARS + PART_TAIL_CHARS) {
      notChecked.push(`${where}: middle ${original.length - PART_HEAD_CHARS - PART_TAIL_CHARS} characters`);
      addStructural('unscanned.oversize', 'unscanned', 'Very long part — only its start and end were checked', 0.3, where, `${original.length} characters`);
      original = `${original.slice(0, PART_HEAD_CHARS)}\n${original.slice(-PART_TAIL_CHARS)}`;
    }
    if (budget <= 0) {
      notChecked.push(where);
      addStructural('unscanned.budget', 'unscanned', 'Message too large — some parts were not checked', 0.3, where, `${text.length} characters`);
      return;
    }
    if (original.length > budget) {
      notChecked.push(`${where}: after ${budget} characters`);
      addStructural('unscanned.budget', 'unscanned', 'Message too large — some parts were not checked', 0.3, where, `${text.length} characters`);
      original = original.slice(0, budget);
    }
    budget -= original.length;
    parts.push({ where, factor, original });
  };

  addPart('sender name', LOCATION_FACTOR.visible, input.fromName);
  // Only free text can carry orders; an ordinary address cannot.
  if (input.from && !/^[^\s@]+@[^\s@]+$|^\+?[\d\s()-]+$/.test(input.from.trim())) addPart('sender', LOCATION_FACTOR.visible, input.from);
  addPart('subject', LOCATION_FACTOR.visible, input.subject);
  addPart('text', LOCATION_FACTOR.visible, input.text);
  for (const extra of input.extra ?? []) addPart(extra.where, LOCATION_FACTOR.visible, extra.text);

  if (input.html) {
    try {
      const { visible, hidden, hiddenTruncated } = extractHtmlText(input.html);
      // The plain-text part may differ from what the HTML shows; scan both.
      if (visible && visible.replace(/\s+/g, ' ') !== (input.text ?? '').replace(/\s+/g, ' ')) addPart('html', LOCATION_FACTOR.visible, visible);
      const hiddenLetters = hidden.reduce((sum, segment) => sum + (segment.text.match(/\p{L}/gu)?.length ?? 0), 0);
      for (const segment of hidden) addPart(`html-hidden (${segment.how})`, LOCATION_FACTOR.hidden, segment.text);
      if (hiddenLetters >= 40) {
        const longest = [...hidden].sort((a, b) => b.text.length - a.text.length)[0];
        addStructural('hidden.html_text', 'hidden', 'HTML contains text a reader does not see', 0.2, `html-hidden (${longest.how})`, longest.text);
      }
      if (hiddenTruncated) {
        notChecked.push('html-hidden: beyond 50 000 characters');
        addStructural('unscanned.hidden', 'unscanned', 'Very long hidden HTML — only part of it was checked', 0.4, 'html-hidden', 'more than 50 000 hidden characters');
      }
    } catch {
      notChecked.push('html (could not be parsed)');
    }
  }

  const attachments = input.attachments ?? [];
  attachments.forEach((attachment, index) => {
    // The saved file name (and so its path) reaches the agent too.
    addPart(`attachment name ${index + 1}`, LOCATION_FACTOR.visible, attachment.name);
    if (index >= MAX_ATTACHMENTS_SCANNED) {
      notChecked.push(`attachment ${attachment.name}`);
      return;
    }
    const content = readTextAttachment(attachment);
    if (content === null) {
      notChecked.push(`attachment ${attachment.name}`);
      return;
    }
    if (/\.html?$/i.test(attachment.name) || /html/i.test(attachment.mime)) {
      try {
        const { visible, hidden } = extractHtmlText(content);
        addPart(`attachment:${attachment.name}`, LOCATION_FACTOR.attachment, visible);
        for (const segment of hidden) addPart(`attachment:${attachment.name} hidden (${segment.how})`, LOCATION_FACTOR.hidden, segment.text);
      } catch {
        // the source below still gets scanned
      }
      // An agent reading the file sees the source, scripts and styles included.
      addPart(`attachment:${attachment.name} (source)`, LOCATION_FACTOR.attachment, content.replace(/<[^>]{0,500}>/g, ' '));
      return;
    }
    addPart(`attachment:${attachment.name}`, LOCATION_FACTOR.attachment, content);
  });

  // Structural tricks and decoded payloads — over every readable part (within the budgets above).
  let decodedLeft = MAX_DECODED_BLOCKS;
  for (const part of [...parts]) {
    const stats = obfuscationStats(part.original);
    if (stats.tagCharacters >= 4) {
      addStructural('obfuscation.tag_characters', 'obfuscation', 'Invisible Unicode tag characters (hidden ASCII text)', 1, part.where, stats.tagText || `${stats.tagCharacters} invisible characters`);
      if (stats.tagText.trim()) addPart(`decoded:unicode-tags in ${part.where}`, LOCATION_FACTOR.decoded, stats.tagText);
    }
    if (stats.zeroWidthInWords >= 3) {
      addStructural('obfuscation.zero_width', 'obfuscation', 'Invisible characters inside words', 0.4, part.where, `${stats.zeroWidthInWords} zero-width characters between letters`);
    }
    if (stats.bidiControls >= 1) {
      addStructural('obfuscation.bidi', 'obfuscation', 'Text-direction override characters', 0.3, part.where, `${stats.bidiControls} direction controls`);
    }
    if (stats.mixedScriptWords >= 2) {
      addStructural('obfuscation.homoglyphs', 'obfuscation', 'Words mixing Latin with Cyrillic/Greek look-alike letters', 0.4, part.where, `${stats.mixedScriptWords} words`);
    }
    const { decoded, skipped } = decodeEmbedded(part.original, decodedLeft);
    decodedLeft -= decoded.length;
    for (const item of decoded) addPart(`decoded:${item.kind} in ${part.where}`, LOCATION_FACTOR.decoded, item.text);
    if (skipped > 0) {
      notChecked.push(`${part.where}: ${skipped} encoded blocks`);
      addStructural('unscanned.encoded', 'unscanned', 'Many encoded blocks — not all were decoded and checked', 0.3, part.where, `${skipped} blocks not decoded`);
    }
  }
  yield;

  for (const part of parts) yield* scanPart(part, add);

  const findings = [...byId.values()].sort((a, b) => b.weight - a.weight);
  const total = score(findings);
  const threshold = THRESHOLDS[sensitivity];
  result.scan = {
    score: total,
    threshold,
    flagged: total >= threshold,
    findings,
    ...(notChecked.length ? { notChecked: notChecked.length > 20 ? [...notChecked.slice(0, 20), `… ${notChecked.length - 20} more`] : notChecked } : {}),
    scannedAt: new Date().toISOString(),
    version: SCANNER_VERSION,
  };
}

/** Used by the eval script and tests: the whole scan at once. */
export function scanForInjection(input: ScanInput, sensitivity: InjectionSensitivity = 'normal'): InjectionScan {
  const result: { scan?: InjectionScan } = {};
  for (const _step of scanSteps(input, sensitivity, result)) {
    // run to completion
  }
  return result.scan!;
}

/**
 * Used by the channels service on every inbound message: the same scan, but it yields to the
 * event loop between parts, so a large message does not stall every chat on the server.
 */
export async function scanForInjectionAsync(input: ScanInput, sensitivity: InjectionSensitivity = 'normal'): Promise<InjectionScan> {
  const result: { scan?: InjectionScan } = {};
  for (const _step of scanSteps(input, sensitivity, result)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return result.scan!;
}
