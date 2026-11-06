import { describe, expect, it } from "vitest";
import {
  base62Decode,
  base62Encode,
  crc32,
  digestOf,
  formatKey,
  mintKey,
  parseKey,
  publicIdOf,
  uuidOfPublicId,
} from "../src/key-format.js";

describe("key format", () => {
  it("encodes base62 with the digits, upper case, then lower case, padded on the left", () => {
    expect(base62Encode(0n, 6)).toBe("000000");
    expect(base62Encode(61n, 1)).toBe("z");
    expect(base62Encode(62n, 2)).toBe("10");
    expect(base62Encode((1n << 128n) - 1n, 22)).toBe("7n42DGM5Tflk9n8mt7Fhc7");
    expect(base62Decode("7n42DGM5Tflk9n8mt7Fhc7")).toBe((1n << 128n) - 1n);
    expect(base62Decode("a-b")).toBeUndefined();
  });

  it("computes the IEEE CRC-32 and writes it as six characters", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
    expect(base62Encode(BigInt(crc32("123456789")), 6)).toBe("3jZRME");
  });

  it("formats a key from fixed bytes as <prefix>_<id><secret><checksum>", () => {
    const id = Uint8Array.from({ length: 16 }, (_, i) => i);
    const secret = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
    const key = formatKey("tk", id, secret);
    expect(key).toBe("tk_000SYW7RiJxkEgOGusQGwpNo287qEH4uQv9vBo5cxQTXAw02KFtzjuPbCrH1FrBEB31oN7z");
    expect(digestOf(key)).toBe("CUxPb5870VTcmtx3UmPTv1ORNZIx6dw2LkTSjKyxo4k");
    expect(publicIdOf("00010203-0405-0607-0809-0a0b0c0d0e0f")).toBe("apk_000SYW7RiJxkEgOGusQGwp");
    expect(uuidOfPublicId("apk_000SYW7RiJxkEgOGusQGwp")).toBe("00010203-0405-0607-0809-0a0b0c0d0e0f");
    expect(parseKey(key)).toEqual({ ok: true, prefix: "tk", uuid: "00010203-0405-0607-0809-0a0b0c0d0e0f" });
  });

  it("refuses a key with any one character changed, or a wrong shape", () => {
    const { key } = mintKey("tk");
    expect(parseKey(key).ok).toBe(true);
    const last = key.length - 1;
    expect(parseKey(key.slice(0, last) + (key[last] === "0" ? "1" : "0")).ok).toBe(false);
    expect(parseKey(key.slice(0, 4) + (key[4] === "0" ? "1" : "0") + key.slice(5)).ok).toBe(false);
    expect(parseKey(key.replace("_", "-")).ok).toBe(false);
    expect(parseKey(key.slice(1)).ok).toBe(false);
    expect(parseKey("").ok).toBe(false);
  });

  it("mints a UUIDv7 id whose public id maps back to it", () => {
    const minted = mintKey("tk", 1_700_000_000_000);
    expect(minted.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidOfPublicId(minted.id)).toBe(minted.uuid);
    expect(minted.digest).toBe(digestOf(minted.key));
  });
});
