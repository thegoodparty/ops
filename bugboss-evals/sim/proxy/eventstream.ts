/**
 * An incremental reader for the AWS event stream framing that
 * InvokeModelWithResponseStream returns. The proxy forwards the upstream bytes
 * untouched and feeds a copy through this, so a bug here can cost the trace a
 * turn's usage but can never change what BugBoss receives.
 *
 * Frame: total length (4), headers length (4), prelude crc (4), headers,
 * payload, message crc (4). CRCs are not checked: the bytes are relayed
 * as-is and BugBoss's SDK checks them.
 */

export type HeaderValue = string | number | boolean | bigint | Uint8Array;

export interface Frame {
  headers: Record<string, HeaderValue>;
  payload: Buffer;
}

const readHeaders = (buffer: Buffer): Record<string, HeaderValue> => {
  const headers: Record<string, HeaderValue> = {};
  let offset = 0;
  while (offset < buffer.length) {
    const nameLength = buffer.readUInt8(offset);
    offset += 1;
    const name = buffer.toString("utf8", offset, offset + nameLength);
    offset += nameLength;
    const type = buffer.readUInt8(offset);
    offset += 1;
    switch (type) {
      case 0:
        headers[name] = true;
        break;
      case 1:
        headers[name] = false;
        break;
      case 2:
        headers[name] = buffer.readInt8(offset);
        offset += 1;
        break;
      case 3:
        headers[name] = buffer.readInt16BE(offset);
        offset += 2;
        break;
      case 4:
        headers[name] = buffer.readInt32BE(offset);
        offset += 4;
        break;
      case 5:
        headers[name] = buffer.readBigInt64BE(offset);
        offset += 8;
        break;
      case 6: {
        const length = buffer.readUInt16BE(offset);
        offset += 2;
        headers[name] = new Uint8Array(buffer.subarray(offset, offset + length));
        offset += length;
        break;
      }
      case 7: {
        const length = buffer.readUInt16BE(offset);
        offset += 2;
        headers[name] = buffer.toString("utf8", offset, offset + length);
        offset += length;
        break;
      }
      case 8:
        headers[name] = Number(buffer.readBigInt64BE(offset));
        offset += 8;
        break;
      case 9:
        headers[name] = buffer.subarray(offset, offset + 16).toString("hex");
        offset += 16;
        break;
      default:
        throw new Error(`event stream header ${name} has unknown type ${type}`);
    }
  }
  return headers;
};

export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    while (this.pending.length >= 12) {
      const total = this.pending.readUInt32BE(0);
      if (total < 16) throw new Error(`event stream frame of length ${total}`);
      if (this.pending.length < total) break;
      const headersLength = this.pending.readUInt32BE(4);
      const headers = readHeaders(this.pending.subarray(12, 12 + headersLength));
      const payload = Buffer.from(this.pending.subarray(12 + headersLength, total - 4));
      frames.push({ headers, payload });
      this.pending = this.pending.subarray(total);
    }
    return frames;
  }

  /** Bytes that never completed a frame, which is a truncated stream. */
  get leftover(): number {
    return this.pending.length;
  }
}
