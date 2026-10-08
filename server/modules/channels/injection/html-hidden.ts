import type { ChildNode, Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';

/**
 * Text in an HTML e-mail that a person does not see but a model does.
 *
 * The classic injection against mail agents is an innocent visible body plus
 * instructions in white-on-white, `display:none`, a zero font size or an HTML
 * comment. Mail clients render CSS, the agent gets plain text — so the agent
 * reads what the owner never saw. Legit newsletters hide a "preheader" the same
 * way; hidden text alone is therefore only a weak signal, but anything a
 * signature finds inside it weighs more.
 */

export type HiddenSegment = { text: string; how: string };

const MAX_HIDDEN_CHARS = 50_000;

type Rgb = [number, number, number];

const NAMED: Record<string, Rgb> = {
  white: [255, 255, 255], black: [0, 0, 0], snow: [255, 250, 250], ivory: [255, 255, 240], whitesmoke: [245, 245, 245],
  ghostwhite: [248, 248, 255], floralwhite: [255, 250, 240], azure: [240, 255, 255], mintcream: [245, 255, 250],
  aliceblue: [240, 248, 255], seashell: [255, 245, 238], linen: [250, 240, 230], beige: [245, 245, 220],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211], gainsboro: [220, 220, 220], silver: [192, 192, 192],
  gray: [128, 128, 128], grey: [128, 128, 128], red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0], navy: [0, 0, 128],
};

function parseColor(value: string | undefined): Rgb | null {
  if (!value) return null;
  const color = value.trim().toLowerCase().replace(/\s*!important$/, '');
  if (color === 'transparent' || color === 'inherit' || color === 'initial' || color === 'currentcolor') return null;
  if (NAMED[color]) return NAMED[color];
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(color);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((d) => d + d).join('') : hex[1];
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/.exec(color);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) < 0.1) return null; // nearly transparent: no colour of its own
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim().toLowerCase();
  }
  return out;
}

function px(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?[\d.]+)\s*(px|pt|em|rem|%)?/.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return match[2] === 'em' || match[2] === 'rem' ? number * 16 : number;
}

/** Why the element hides its content, or null when it does not. */
function hiddenBy(element: Element, style: Record<string, string>): string | null {
  const attrs = element.attribs ?? {};
  if ('hidden' in attrs) return 'hidden attribute';
  if (element.name === 'template') return '<template>';
  if (style.display === 'none') return 'display:none';
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'visibility:hidden';
  if (style['mso-hide'] === 'all') return 'mso-hide:all';
  const opacity = style.opacity === undefined ? null : Number(style.opacity);
  if (opacity !== null && !Number.isNaN(opacity) && opacity < 0.1) return 'opacity:0';
  const fontSize = px(style['font-size']);
  if (fontSize !== null && fontSize <= 1) return 'font-size:0';
  const overflowHidden = (style.overflow ?? style['overflow-y'] ?? '').startsWith('hidden');
  if (overflowHidden && ((px(style['max-height']) ?? 1) <= 1 || (px(style.height) ?? 1) <= 1 || (px(style['max-width']) ?? 1) <= 1 || (px(style.width) ?? 1) <= 1)) return 'zero size';
  if ((style.position === 'absolute' || style.position === 'fixed') && ((px(style.left) ?? 0) <= -500 || (px(style.top) ?? 0) <= -500)) return 'off-screen';
  if ((px(style['text-indent']) ?? 0) <= -500) return 'off-screen';
  if (/rect\(\s*0/.test(style.clip ?? '') || /scale\(\s*0(\.0+)?\s*[,)]/.test(style.transform ?? '')) return 'clipped';
  if (attrs['aria-hidden'] === 'true' && fontSize !== null && fontSize < 4) return 'aria-hidden tiny';
  return null;
}

/** Visible text and hidden segments of an HTML body. */
export function extractHtmlText(html: string): { visible: string; hidden: HiddenSegment[]; hiddenTruncated: boolean } {
  const document = parseDocument(html, { decodeEntities: true, lowerCaseAttributeNames: true });
  const visible: string[] = [];
  const hidden: HiddenSegment[] = [];
  let hiddenChars = 0;
  let hiddenTruncated = false;

  const pushHidden = (text: string, how: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (hiddenChars >= MAX_HIDDEN_CHARS) {
      hiddenTruncated = true;
      return;
    }
    hiddenChars += clean.length;
    const last = hidden[hidden.length - 1];
    if (last && last.how === how) last.text += ` ${clean}`;
    else hidden.push({ text: clean, how });
  };

  const walk = (nodes: ChildNode[], hiddenReason: string | null, color: Rgb | null, background: Rgb) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = node.data;
        if (!text.trim()) continue;
        // Text the same colour as what is behind it (white on white, #fefefe on #fff).
        const camouflaged = color && Math.abs(luminance(color) - luminance(background)) < 0.08;
        if (hiddenReason) pushHidden(text, hiddenReason);
        else if (camouflaged) pushHidden(text, 'same colour as background');
        else visible.push(text);
        continue;
      }
      if (node.type === 'comment') {
        pushHidden(node.data, 'HTML comment');
        continue;
      }
      if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') continue;
      const element = node as Element;
      const name = element.name.toLowerCase();
      if (name === 'script' || name === 'style' || name === 'noscript') continue;
      if (name === 'title') {
        // Mail clients do not show the document title.
        pushHidden(element.children.map((child) => (child.type === 'text' ? child.data : '')).join(' '), '<title>');
        continue;
      }
      const attrs = element.attribs ?? {};
      for (const attribute of ['alt', 'title', 'aria-label', 'data-instructions']) {
        if (attrs[attribute] && attrs[attribute].length > 20) pushHidden(attrs[attribute], `${attribute} attribute`);
      }
      if (name === 'meta' && attrs.content && attrs.content.length > 40) pushHidden(attrs.content, '<meta>');
      if (name === 'input' && attrs.type === 'hidden' && attrs.value) pushHidden(attrs.value, 'hidden input');

      const style = parseStyle(attrs.style);
      const ownBackground = parseColor(style['background-color'] ?? style.background?.split(/\s+/).find((part) => parseColor(part)) ?? attrs.bgcolor);
      const ownColor = parseColor(style.color ?? attrs.color);
      walk(
        element.children,
        hiddenReason ?? hiddenBy(element, style),
        ownColor ?? color,
        ownBackground ?? background,
      );
      if (['p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'table', 'section'].includes(name)) visible.push('\n');
    }
  };

  walk(document.children, null, null, [255, 255, 255]);
  return { visible: visible.join(' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), hidden, hiddenTruncated };
}
