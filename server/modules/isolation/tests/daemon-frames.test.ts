import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameDecoder, encodeFrame, type FrameType } from '../daemon/frames.js';

const TYPES: FrameType[] = ['stdin', 'stdin_end', 'stdout', 'stderr', 'exit', 'kill', 'resize', 'error'];

test('round-trips every frame type', () => {
  for (const type of TYPES) {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(type, `payload-${type}`));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, type);
    assert.equal(frames[0].payload.toString(), `payload-${type}`);
  }
});

test('handles empty payload', () => {
  const frames = new FrameDecoder().push(encodeFrame('stdin_end', ''));
  assert.deepEqual(frames.map((f) => [f.type, f.payload.length]), [['stdin_end', 0]]);
});

test('reassembles a frame split into 3 chunks', () => {
  const encoded = encodeFrame('stdout', 'hello world');
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3, 9)), []);
  const frames = decoder.push(encoded.subarray(9));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), 'hello world');
});

test('decodes two frames delivered in one chunk', () => {
  const chunk = Buffer.concat([encodeFrame('stdout', 'a'), encodeFrame('stderr', 'b')]);
  const frames = new FrameDecoder().push(chunk);
  assert.deepEqual(frames.map((f) => [f.type, f.payload.toString()]), [['stdout', 'a'], ['stderr', 'b']]);
});

test('carries a 5 MB payload byte-exact', () => {
  const payload = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  const encoded = encodeFrame('stdin', payload);
  const decoder = new FrameDecoder();
  const frames = [];
  for (let offset = 0; offset < encoded.length; offset += 65536) {
    frames.push(...decoder.push(encoded.subarray(offset, offset + 65536)));
  }
  assert.equal(frames.length, 1);
  assert.ok(frames[0].payload.equals(payload));
});

test('rejects an unknown type byte', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.from([99, 0, 0, 0, 0])));
});
