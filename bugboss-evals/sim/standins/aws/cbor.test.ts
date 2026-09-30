import assert from "node:assert/strict";
import { test } from "node:test";

import { decode, encode, type Value } from "./cbor";

test("round-trips every type the rpc-v2-cbor protocol uses", () => {
  const value: Value = {
    small: 5,
    byte: 200,
    short: 60_000,
    word: 4_000_000_000,
    big: 2 ** 40,
    negative: -1,
    negativeBig: -70_000,
    float: 1.5,
    text: "héllo",
    empty: "",
    bytes: new Uint8Array([1, 2, 3]),
    list: [1, "two", null, true, false],
    nested: { inner: [{ deep: 0.25 }] },
    none: null,
  };
  assert.deepEqual(decode(encode(value)), value);
});

test("encodes a Date as tag 1 and decodes it back to a Date", () => {
  const at = new Date(Date.UTC(2026, 8, 29, 12, 0, 0, 500));
  const bytes = encode({ at });
  assert.ok(bytes.includes(0xc1), "tag 1 is present");
  const out = decode(bytes) as { at: Date };
  assert.ok(out.at instanceof Date);
  assert.equal(out.at.getTime(), at.getTime());
});

test("matches RFC 8949 appendix A encodings", () => {
  assert.deepEqual([...encode(0)], [0x00]);
  assert.deepEqual([...encode(23)], [0x17]);
  assert.deepEqual([...encode(24)], [0x18, 0x18]);
  assert.deepEqual([...encode(1000)], [0x19, 0x03, 0xe8]);
  assert.deepEqual([...encode(-10)], [0x29]);
  assert.deepEqual([...encode("a")], [0x61, 0x61]);
  assert.deepEqual([...encode([1, 2])], [0x82, 0x01, 0x02]);
  assert.deepEqual([...encode(true)], [0xf5]);
  assert.deepEqual([...encode(null)], [0xf6]);
});

test("decodes half and single precision floats", () => {
  assert.equal(decode(Buffer.from([0xf9, 0x3c, 0x00])), 1);
  assert.equal(decode(Buffer.from([0xf9, 0xc4, 0x00])), -4);
  assert.equal(decode(Buffer.from([0xfa, 0x47, 0xc3, 0x50, 0x00])), 100000);
});

test("decodes indefinite-length strings, arrays and maps", () => {
  assert.equal(
    decode(Buffer.from([0x7f, 0x62, 0x61, 0x62, 0x61, 0x63, 0xff])),
    "abc",
  );
  assert.deepEqual(decode(Buffer.from([0x9f, 0x01, 0x02, 0xff])), [1, 2]);
  assert.deepEqual(decode(Buffer.from([0xbf, 0x61, 0x61, 0x01, 0xff])), {
    a: 1,
  });
});

test("refuses truncated input rather than inventing a value", () => {
  assert.throws(() => decode(Buffer.from([0x82, 0x01])), /unexpected end/);
});
