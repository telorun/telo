/**
 * SHA-256, in this package's own code.
 *
 * A cache key decides which emitted module is loaded, so its hash must be
 * collision-resistant: a collision serves another expression set's code, which is the one
 * failure here that no retry undoes. So it is a cryptographic digest rather than a cheap
 * checksum.
 *
 * It is implemented here rather than taken from a platform because of what this package
 * is allowed to reach. `node:crypto` is a Node built-in, which the browser-safety gate
 * refuses; `crypto.subtle.digest` is **asynchronous**, and emission happens on a path that
 * is synchronous end to end. Sixty lines of arithmetic is the price of keeping both
 * properties, and the digest is held to the published test vectors
 * (`tests/emitted-module.test.ts`).
 */

import { textToBytes } from "./value-text.js";

/** The first 32 bits of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

function rotateRight(value: number, by: number): number {
  return (value >>> by) | (value << (32 - by));
}

/** The digest of bytes, as 64 lowercase hexadecimal characters. */
export function sha256Hex(input: Uint8Array): string {
  const length = input.length;
  // The message, a 0x80 byte, zero padding to 56 mod 64, then the bit length as 64 bits.
  const padded = new Uint8Array(((length + 72) >> 6) << 6);
  padded.set(input);
  padded[length] = 0x80;
  const bits = BigInt(length) * 8n;
  for (let at = 0; at < 8; at += 1) {
    padded[padded.length - 1 - at] = Number((bits >> BigInt(8 * at)) & 0xffn);
  }

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let at = 0; at < 16; at += 1) {
      const from = block + at * 4;
      schedule[at] =
        ((padded[from]! << 24) | (padded[from + 1]! << 16) | (padded[from + 2]! << 8) | padded[from + 3]!) >>> 0;
    }
    for (let at = 16; at < 64; at += 1) {
      const a = schedule[at - 15]!;
      const b = schedule[at - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      schedule[at] = (schedule[at - 16]! + s0 + schedule[at - 7]! + s1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let at = 0; at < 64; at += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const one = (h + s1 + choose + K[at]! + schedule[at]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const two = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + one) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (one + two) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  let out = "";
  for (const word of state) {
    for (let shift = 28; shift >= 0; shift -= 4) out += HEX[(word >>> shift) & 0xf];
  }
  return out;
}

/** The digest of text, read as UTF-8 — what every key and digest in the emitter is over. */
export function sha256OfText(text: string): string {
  return sha256Hex(textToBytes(text));
}
