// The subset of CBOR (RFC 8949) that Smithy RPC v2 uses: definite and
// indefinite strings, arrays and maps, integers, floats, simple values and
// tag 1 (epoch timestamps). Enough for CloudWatch's rpc-v2-cbor protocol.

export type Value =
  | null
  | undefined
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | Value[]
  | { [key: string]: Value };

const head = (major: number, length: number): number[] => {
  const top = major << 5;
  if (length < 24) return [top | length];
  if (length < 0x100) return [top | 24, length];
  if (length < 0x10000) return [top | 25, length >> 8, length & 0xff];
  if (length < 0x100000000) {
    return [
      top | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ];
  }
  const high = Math.floor(length / 0x100000000);
  const low = length >>> 0;
  return [
    top | 27,
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  ];
};

const float64 = (value: number): number[] => {
  const buffer = Buffer.alloc(9);
  buffer[0] = 0xfb;
  buffer.writeDoubleBE(value, 1);
  return [...buffer];
};

const encodeInto = (value: Value, out: number[]): void => {
  if (value === null) {
    out.push(0xf6);
    return;
  }
  if (value === undefined) {
    out.push(0xf7);
    return;
  }
  if (typeof value === "boolean") {
    out.push(value ? 0xf5 : 0xf4);
    return;
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      if (value >= 0) out.push(...head(0, value));
      else out.push(...head(1, -1 - value));
    } else {
      out.push(...float64(value));
    }
    return;
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    out.push(...head(3, bytes.length), ...bytes);
    return;
  }
  if (value instanceof Date) {
    out.push(0xc1);
    encodeInto(value.getTime() / 1000, out);
    return;
  }
  if (value instanceof Uint8Array) {
    out.push(...head(2, value.length), ...value);
    return;
  }
  if (Array.isArray(value)) {
    out.push(...head(4, value.length));
    for (const item of value) encodeInto(item, out);
    return;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  out.push(...head(5, entries.length));
  for (const [key, item] of entries) {
    encodeInto(key, out);
    encodeInto(item, out);
  }
};

export const encode = (value: Value): Buffer => {
  const out: number[] = [];
  encodeInto(value, out);
  return Buffer.from(out);
};

const BREAK = Symbol("break");

export const decode = (input: Uint8Array): Value => {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;

  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return bytes[offset++];
    if (info === 25) {
      const n = bytes.readUInt16BE(offset);
      offset += 2;
      return n;
    }
    if (info === 26) {
      const n = bytes.readUInt32BE(offset);
      offset += 4;
      return n;
    }
    if (info === 27) {
      const high = bytes.readUInt32BE(offset);
      const low = bytes.readUInt32BE(offset + 4);
      offset += 8;
      return high * 0x100000000 + low;
    }
    throw new Error(`cbor: unsupported length encoding ${info}`);
  };

  const readItem = (): Value | typeof BREAK => {
    if (offset >= bytes.length) throw new Error("cbor: unexpected end of input");
    const initial = bytes[offset++];
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) {
        const value = halfToNumber(bytes.readUInt16BE(offset));
        offset += 2;
        return value;
      }
      if (info === 26) {
        const value = bytes.readFloatBE(offset);
        offset += 4;
        return value;
      }
      if (info === 27) {
        const value = bytes.readDoubleBE(offset);
        offset += 8;
        return value;
      }
      if (info === 31) return BREAK;
      throw new Error(`cbor: unsupported simple value ${info}`);
    }

    const indefinite = info === 31;

    if (major === 0) return readLength(info);
    if (major === 1) return -1 - readLength(info);

    if (major === 2 || major === 3) {
      const chunks: Buffer[] = [];
      if (indefinite) {
        for (;;) {
          const chunk = readItem();
          if (chunk === BREAK) break;
          chunks.push(
            typeof chunk === "string"
              ? Buffer.from(chunk, "utf8")
              : Buffer.from(chunk as Uint8Array),
          );
        }
      } else {
        const length = readLength(info);
        chunks.push(bytes.subarray(offset, offset + length));
        offset += length;
      }
      const joined = Buffer.concat(chunks);
      return major === 3 ? joined.toString("utf8") : new Uint8Array(joined);
    }

    if (major === 4) {
      const items: Value[] = [];
      if (indefinite) {
        for (;;) {
          const item = readItem();
          if (item === BREAK) break;
          items.push(item);
        }
      } else {
        const length = readLength(info);
        for (let i = 0; i < length; i++) items.push(readValue());
      }
      return items;
    }

    if (major === 5) {
      const map: { [key: string]: Value } = {};
      const readPair = (key: Value): void => {
        map[String(key)] = readValue();
      };
      if (indefinite) {
        for (;;) {
          const key = readItem();
          if (key === BREAK) break;
          readPair(key);
        }
      } else {
        const length = readLength(info);
        for (let i = 0; i < length; i++) readPair(readValue());
      }
      return map;
    }

    if (major === 6) {
      const tag = readLength(info);
      const inner = readValue();
      if (tag === 1 && typeof inner === "number") return new Date(inner * 1000);
      return inner;
    }

    throw new Error(`cbor: unsupported major type ${major}`);
  };

  const readValue = (): Value => {
    const item = readItem();
    if (item === BREAK) throw new Error("cbor: unexpected break");
    return item;
  };

  const value = readValue();
  return value;
};

const halfToNumber = (half: number): number => {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};
