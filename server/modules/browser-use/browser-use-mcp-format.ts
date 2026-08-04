// ethia fork: MCP response shaping for Browser tools.
//
// Sessions carry their screenshot as a base64 data URL. Inlining that in the
// JSON tool result overflows the tool-output limit and burns tokens on every
// call, so it is stripped everywhere and re-attached as a real image block only
// by the tools that are asked for a picture.

export const SCREENSHOT_PLACEHOLDER = 'omitted - call browser_take_screenshot to see the page';

export type DataUrlImage = { data: string; mimeType: string };

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export function parseDataUrl(value: unknown): DataUrlImage | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

export function stripScreenshots(value: unknown): { value: unknown; image: DataUrlImage | null } {
  let image: DataUrlImage | null = null;

  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (!input || typeof input !== 'object') {
      return input;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (key === 'screenshotDataUrl') {
        image = parseDataUrl(item) || image;
        result[key] = item === null || item === undefined ? null : SCREENSHOT_PLACEHOLDER;
        continue;
      }
      result[key] = walk(item);
    }
    return result;
  };

  return { value: walk(value), image };
}

export function textResponse(text: string): { content: McpContent[] } {
  return { content: [{ type: 'text', text }] };
}

export function jsonResponse(value: unknown): { content: McpContent[] } {
  return textResponse(JSON.stringify(stripScreenshots(value).value, null, 2));
}

/** JSON payload plus the page screenshot as an actual image block. */
export function screenshotResponse(value: unknown): { content: McpContent[] } {
  const { value: stripped, image } = stripScreenshots(value);
  const text: McpContent = { type: 'text', text: JSON.stringify(stripped, null, 2) };
  return {
    content: image
      ? [{ type: 'image', data: image.data, mimeType: image.mimeType }, text]
      : [text],
  };
}
