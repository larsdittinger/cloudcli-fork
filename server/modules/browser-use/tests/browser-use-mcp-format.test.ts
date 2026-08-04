import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jsonResponse,
  parseDataUrl,
  screenshotResponse,
  SCREENSHOT_PLACEHOLDER,
  stripScreenshots,
} from '@/modules/browser-use/browser-use-mcp-format.js';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUg==';
const DATA_URL = `data:image/jpeg;base64,${PIXEL}`;

test('parses base64 data URLs and rejects anything else', () => {
  assert.deepEqual(parseDataUrl(DATA_URL), { mimeType: 'image/jpeg', data: PIXEL });
  assert.equal(parseDataUrl('https://ethia.cz/a.jpg'), null);
  assert.equal(parseDataUrl(null), null);
});

test('screenshots are replaced by a placeholder everywhere in the payload', () => {
  const { value, image } = stripScreenshots({
    session: { id: 'a', screenshotDataUrl: DATA_URL },
    tabs: [{ index: 0, screenshotDataUrl: DATA_URL }],
  });

  assert.deepEqual(value, {
    session: { id: 'a', screenshotDataUrl: SCREENSHOT_PLACEHOLDER },
    tabs: [{ index: 0, screenshotDataUrl: SCREENSHOT_PLACEHOLDER }],
  });
  assert.deepEqual(image, { mimeType: 'image/jpeg', data: PIXEL });
});

test('a session without a screenshot stays null and yields no image', () => {
  const { value, image } = stripScreenshots({ screenshotDataUrl: null });

  assert.deepEqual(value, { screenshotDataUrl: null });
  assert.equal(image, null);
});

test('json responses never carry base64 payloads', () => {
  const response = jsonResponse({ session: { screenshotDataUrl: DATA_URL } });

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.equal((response.content[0] as { text: string }).text.includes(PIXEL), false);
});

test('screenshot responses attach the image as its own content block', () => {
  const response = screenshotResponse({ session: { screenshotDataUrl: DATA_URL }, text: 'hello' });

  assert.deepEqual(response.content[0], { type: 'image', data: PIXEL, mimeType: 'image/jpeg' });
  assert.equal(response.content[1].type, 'text');
  assert.match((response.content[1] as { text: string }).text, /hello/);
});

test('screenshot responses degrade to text when there is no image yet', () => {
  const response = screenshotResponse({ session: { screenshotDataUrl: null } });

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
});
