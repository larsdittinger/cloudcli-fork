// Frame codec shared by the main app and the sandbox daemon.
// Node builtins only: the daemon runs standalone in a slim image.

export type FrameType =
  | 'stdin'
  | 'stdin_end'
  | 'stdout'
  | 'stderr'
  | 'exit'
  | 'kill'
  | 'resize'
  | 'error';

const TYPE_TO_BYTE: Record<FrameType, number> = {
  stdin: 1,
  stdin_end: 2,
  stdout: 3,
  stderr: 4,
  exit: 5,
  kill: 6,
  resize: 7,
  error: 8,
};

const BYTE_TO_TYPE = new Map<number, FrameType>(
  (Object.keys(TYPE_TO_BYTE) as FrameType[]).map((type) => [TYPE_TO_BYTE[type], type]),
);

const HEADER_BYTES = 5;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export type Frame = { type: FrameType; payload: Buffer };

/** Layout: 1 byte type, 4 bytes payload length (big endian), payload. */
export function encodeFrame(type: FrameType, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const typeByte = TYPE_TO_BYTE[type];
  if (typeByte === undefined) {
    throw new Error(`Unknown frame type: ${String(type)}`);
  }
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(typeByte, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const frames: Frame[] = [];
    let offset = 0;
    while (this.buffered.length - offset >= HEADER_BYTES) {
      const type = BYTE_TO_TYPE.get(this.buffered.readUInt8(offset));
      const length = this.buffered.readUInt32BE(offset + 1);
      if (!type) {
        throw new Error(`Unknown frame type byte: ${this.buffered.readUInt8(offset)}`);
      }
      if (length > MAX_PAYLOAD_BYTES) {
        throw new Error(`Frame payload too large: ${length}`);
      }
      if (this.buffered.length - offset - HEADER_BYTES < length) {
        break;
      }
      const start = offset + HEADER_BYTES;
      frames.push({ type, payload: Buffer.from(this.buffered.subarray(start, start + length)) });
      offset = start + length;
    }
    this.buffered = offset === 0 ? this.buffered : Buffer.from(this.buffered.subarray(offset));
    return frames;
  }
}
