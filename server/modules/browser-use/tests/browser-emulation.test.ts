import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultEmulation,
  findPreset,
  isViewportOnlyChange,
  listPresets,
  resolveEmulation,
  toContextOptions,
} from '@/modules/browser-use/browser-emulation.js';

test('defaults to a desktop viewport without touch', () => {
  const emulation = defaultEmulation();

  assert.equal(emulation.preset, 'desktop');
  assert.equal(emulation.width, 1440);
  assert.equal(emulation.height, 900);
  assert.equal(emulation.isMobile, false);
  assert.equal(emulation.hasTouch, false);
});

test('resolves phone presets by id, label, and alias', () => {
  for (const name of ['iphone-15', 'iPhone 15', 'IPHONE15', 'mobile', 'phone']) {
    const emulation = resolveEmulation({ device: name });
    assert.equal(emulation.preset, 'iphone-15', `${name} should map to iphone-15`);
    assert.equal(emulation.width, 393);
    assert.equal(emulation.isMobile, true);
    assert.equal(emulation.hasTouch, true);
    assert.match(emulation.userAgent || '', /iPhone/);
  }
});

test('rejects unknown device names with the available list', () => {
  assert.throws(
    () => resolveEmulation({ device: 'nokia-3310' }),
    /Unknown device "nokia-3310"[\s\S]*iphone-15/,
  );
});

test('custom width/height overrides the preset and clears the preset id', () => {
  const emulation = resolveEmulation({ device: 'iphone-15', width: 320, height: 640 });

  assert.equal(emulation.width, 320);
  assert.equal(emulation.height, 640);
  assert.equal(emulation.preset, null);
  assert.equal(emulation.label, 'Custom 320x640');
  // Touch characteristics from the preset survive a manual resize.
  assert.equal(emulation.hasTouch, true);
});

test('a custom size matching a preset keeps that preset id', () => {
  const emulation = resolveEmulation({ width: 375, height: 667 });

  assert.equal(emulation.preset, 'iphone-se');
});

test('clamps absurd dimensions instead of failing', () => {
  const tiny = resolveEmulation({ width: 1, height: 1 });
  const huge = resolveEmulation({ width: 99_999, height: 99_999 });

  assert.equal(tiny.width, 200);
  assert.equal(huge.width, 3840);
});

test('isMobile implies touch unless hasTouch is pinned', () => {
  assert.equal(resolveEmulation({ isMobile: true }).hasTouch, true);
  assert.equal(resolveEmulation({ isMobile: true, hasTouch: false }).hasTouch, false);
});

test('landscape swaps the phone viewport', () => {
  const emulation = resolveEmulation({ device: 'iphone-15', landscape: true });

  assert.equal(emulation.width, 852);
  assert.equal(emulation.height, 393);
  assert.equal(emulation.landscape, true);
});

test('merging onto an existing emulation only changes what was passed', () => {
  const base = resolveEmulation({ device: 'pixel-7' });
  const next = resolveEmulation({ width: 400 }, base);

  assert.equal(next.height, base.height);
  assert.equal(next.deviceScaleFactor, base.deviceScaleFactor);
  assert.equal(next.userAgent, base.userAgent);
  assert.equal(next.width, 400);
});

test('context options carry the emulation into playwright', () => {
  const options = toContextOptions(resolveEmulation({ device: 'iphone-se' })) as Record<string, any>;

  assert.deepEqual(options.viewport, { width: 375, height: 667 });
  assert.equal(options.deviceScaleFactor, 2);
  assert.equal(options.isMobile, true);
  assert.equal(options.hasTouch, true);
  assert.match(options.userAgent, /iPhone/);
});

test('desktop context options omit the user agent override', () => {
  const options = toContextOptions(defaultEmulation()) as Record<string, any>;

  assert.equal('userAgent' in options, false);
});

test('viewport-only changes avoid a context restart', () => {
  const base = defaultEmulation();

  assert.equal(isViewportOnlyChange(base, resolveEmulation({ width: 1280 }, base)), true);
  assert.equal(isViewportOnlyChange(base, resolveEmulation({ device: 'iphone-15' }, base)), false);
  assert.equal(isViewportOnlyChange(base, base), false);
});

test('preset catalog exposes phones, tablets, and desktops', () => {
  const categories = new Set(listPresets().map((preset) => preset.category));

  assert.deepEqual([...categories].sort(), ['desktop', 'phone', 'tablet']);
  assert.ok(findPreset('ipad'));
});
