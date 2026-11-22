import { describe, expect, it } from "vitest";
import {
  parseDictionary,
  parseSignatureInput,
  parseSignatures,
  serializeInnerList,
  StructuredFieldError,
  SignatureMalformed,
  type InnerList,
} from "../src/index.js";

describe("Signature-Input", () => {
  it("reads labels, components and the keyid, alg, created and expires parameters, ignoring nonce", () => {
    const inputs = parseSignatureInput(
      'sig1=("@method" "content-digest");created=1618884473;keyid="k1";alg="hmac-sha256";expires=1618884773;nonce="abc";tag="x", sig2=();created=1',
    );
    expect([...inputs.keys()]).toEqual(["sig1", "sig2"]);
    expect(inputs.get("sig1")).toMatchObject({ keyId: "k1", algorithm: "hmac-sha256", created: 1618884473, expires: 1618884773 });
    expect(inputs.get("sig1")!.components.map((c) => c.value)).toEqual([
      { type: "string", value: "@method" },
      { type: "string", value: "content-digest" },
    ]);
    expect(inputs.get("sig2")).toMatchObject({ keyId: null, algorithm: null, created: 1, expires: null });
  });

  it("serializes the parameters as received, in order", () => {
    const text = '("@query-param";name="Pet" "date");created=1618884473;keyid="k";nonce="n"';
    expect(parseSignatureInput(`s=${text}`).get("s")!.signatureParams).toBe(text);
  });

  it("refuses a parameter of the wrong type and a member that is not a list", () => {
    expect(() => parseSignatureInput('s=();created="1"')).toThrow(SignatureMalformed);
    expect(() => parseSignatureInput("s=1")).toThrow(SignatureMalformed);
    expect(() => parseSignatureInput("s=(")).toThrow(SignatureMalformed);
  });
});

describe("Signature", () => {
  it("reads byte sequences by label", () => {
    const signatures = parseSignatures("a=:AQID:, b=:BAUG:");
    expect([...signatures.get("a")!]).toEqual([1, 2, 3]);
    expect([...signatures.get("b")!]).toEqual([4, 5, 6]);
  });

  it("refuses anything but byte sequences", () => {
    expect(() => parseSignatures('a="x"')).toThrow(SignatureMalformed);
  });
});

describe("structured field values", () => {
  it("reads every bare item type and writes them back", () => {
    const dictionary = parseDictionary('i=-5, d=1.50, s="a\\"b", t=tok/en, b=:AQID:, f=?0, dt=@12, p=%"caf%c3%a9", flag');
    expect([...dictionary.values()].map((m) => ("items" in m ? null : m.value))).toEqual([
      { type: "integer", value: -5 },
      { type: "decimal", value: 1.5 },
      { type: "string", value: 'a"b' },
      { type: "token", value: "tok/en" },
      { type: "bytes", value: new Uint8Array([1, 2, 3]) },
      { type: "boolean", value: false },
      { type: "date", value: 12 },
      { type: "display", value: "café" },
      { type: "boolean", value: true },
    ]);
    const list = parseDictionary('x=(1 1.5 "a\\"b" t :AQID: ?0 @12 %"caf%c3%a9");p;q=?0').get("x") as InnerList;
    expect(serializeInnerList(list)).toBe('(1 1.5 "a\\"b" t :AQID: ?0 @12 %"caf%c3%a9");p;q=?0');
  });

  it("refuses malformed input with its offset", () => {
    for (const bad of ["a=", 'a="x', "a=1,", "A=1", "a=:*:", "a=1 b=2"]) {
      expect(() => parseDictionary(bad), bad).toThrow(StructuredFieldError);
    }
  });
});
