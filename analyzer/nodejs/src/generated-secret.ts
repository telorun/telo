import { canonicalJson } from "./canonical-json.js";

/**
 * GENERATED SECRETS — the two kernel-declared need types a host answers from its
 * one secret seed (`Telo.GeneratedSecretKey`, `Telo.GeneratedPassword`), and the
 * one reader of what their parameters mean: the rules the parameters schema
 * cannot state, the rules a value supplied in place of the derivation is held
 * to, a key's encodings, and the derivation's `info` text. Shared by `telo check`
 * (the need table) and the kernel (the derivation and its refusals at load), so
 * the two cannot read a parameter or a value differently.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

export const GENERATED_SECRET_KEY_TYPE = "Telo.GeneratedSecretKey";
export const GENERATED_PASSWORD_TYPE = "Telo.GeneratedPassword";

/** The host value both types are derived from: 32 bytes, unpadded base64url. */
export const SECRET_SEED_HOST_VALUE = "TELO_HOST_SECRET_SEED";

export type KeyEncoding = "base64url" | "base64url-padded" | "base64" | "hex";

export interface GeneratedKeyParameters {
  bytes: number;
  encoding: KeyEncoding;
}

export interface CharacterSet {
  characters: string;
  minimum: number;
}

export interface GeneratedPasswordParameters {
  length: number;
  characterSets: CharacterSet[];
}

/** Whether a canonical need type is one of the two generated types. */
export function isGeneratedSecretType(type: string | undefined): boolean {
  return type === GENERATED_SECRET_KEY_TYPE || type === GENERATED_PASSWORD_TYPE;
}

/** The one field a generated type yields. */
export function generatedSecretField(type: string | undefined): "key" | "password" | undefined {
  return type === GENERATED_SECRET_KEY_TYPE ? "key" : type === GENERATED_PASSWORD_TYPE ? "password" : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const KEY_ENCODINGS: readonly KeyEncoding[] = ["base64url", "base64url-padded", "base64", "hex"];

/** A key need's parameters, or undefined when they are not ones the type accepts. */
export function generatedKeyParameters(parameters: unknown): GeneratedKeyParameters | undefined {
  if (!isRecord(parameters)) return undefined;
  const { bytes, encoding } = parameters;
  if (typeof bytes !== "number" || !Number.isInteger(bytes)) return undefined;
  if (!KEY_ENCODINGS.includes(encoding as KeyEncoding)) return undefined;
  return { bytes, encoding: encoding as KeyEncoding };
}

/** A password need's parameters, each set's `minimum` defaulting to 0, or
 *  undefined when they are not ones the type's schema accepts. */
export function generatedCharacterRules(parameters: unknown): GeneratedPasswordParameters | undefined {
  if (!isRecord(parameters)) return undefined;
  const { length, characterSets } = parameters;
  if (typeof length !== "number" || !Number.isInteger(length)) return undefined;
  if (!Array.isArray(characterSets)) return undefined;
  const sets: CharacterSet[] = [];
  for (const set of characterSets) {
    if (!isRecord(set) || typeof set.characters !== "string") return undefined;
    const minimum = set.minimum ?? 0;
    if (typeof minimum !== "number" || !Number.isInteger(minimum)) return undefined;
    sets.push({ characters: set.characters, minimum });
  }
  return { length, characterSets: sets };
}

/** The parameters a value of `type` is identified by, defaults filled, in the
 *  shape the derivation's `info` is written from; undefined when they are not
 *  ones the type accepts. */
function identifyingParameters(type: string, parameters: unknown): Record<string, unknown> | undefined {
  if (type === GENERATED_SECRET_KEY_TYPE) {
    const key = generatedKeyParameters(parameters);
    return key ? { bytes: key.bytes, encoding: key.encoding } : undefined;
  }
  if (type === GENERATED_PASSWORD_TYPE) {
    const rules = generatedCharacterRules(parameters);
    return rules
      ? {
          length: rules.length,
          characterSets: rules.characterSets.map((set) => ({ characters: set.characters, minimum: set.minimum })),
        }
      : undefined;
  }
  return undefined;
}

/**
 * The derivation's `info`: `telo/<kind>/<need path>/<parameters>`, the
 * parameters as RFC 8785 canonical JSON with defaults filled — the identity a
 * value is derived under. Undefined for parameters the type refuses.
 */
export function generatedSecretInfo(
  type: string,
  path: readonly string[],
  parameters: unknown,
): string | undefined {
  const identifying = identifyingParameters(type, parameters);
  return identifying ? `telo/${type}/${path.join(".")}/${canonicalJson(identifying)}` : undefined;
}

/** A parameter rule broken, at its path relative to the need's `parameters`. */
export interface GeneratedParameterRefusal {
  path: string;
  message: string;
}

/**
 * The rules a password's parameters break that its schema cannot state: a
 * character twice within or across sets, and minimums summing past `length`.
 * A key's schema states every rule of its own.
 */
export function generatedParameterRefusals(type: string, parameters: unknown): GeneratedParameterRefusal[] {
  if (type !== GENERATED_PASSWORD_TYPE) return [];
  const reading = generatedCharacterRules(parameters);
  if (!reading) return [];
  const out: GeneratedParameterRefusal[] = [];
  const owner = new Map<string, number>();
  reading.characterSets.forEach((set, i) => {
    const at = `characterSets[${i}].characters`;
    for (const character of set.characters) {
      const first = owner.get(character);
      if (first === undefined) {
        owner.set(character, i);
      } else if (first === i) {
        out.push({ path: at, message: `characterSets[${i}] holds '${character}' twice` });
      } else {
        out.push({ path: at, message: `characterSets[${first}] and characterSets[${i}] both hold '${character}'` });
      }
    }
  });
  const sum = reading.characterSets.reduce((total, set) => total + set.minimum, 0);
  if (sum > reading.length) {
    out.push({
      path: "characterSets",
      message: `the minimums of characterSets add up to ${sum}, more than 'length: ${reading.length}'`,
    });
  }
  return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";

function alphabetOf(encoding: Exclude<KeyEncoding, "hex">): string {
  return encoding === "base64" ? BASE64 : BASE64URL;
}

/** Key bytes in `encoding`'s canonical text. */
export function encodeKey(bytes: Uint8Array, encoding: KeyEncoding): string {
  if (encoding === "hex") {
    let out = "";
    for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
    return out;
  }
  const alphabet = alphabetOf(encoding);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const word = (a << 16) | (b << 8) | c;
    const take = Math.min(3, bytes.length - i) + 1;
    for (let k = 0; k < 4; k++) {
      if (k < take) out += alphabet[(word >> (18 - 6 * k)) & 63]!;
      else if (encoding !== "base64url") out += "=";
    }
  }
  return out;
}

/** The bytes `text` holds under `encoding`, read leniently — hex in either case,
 *  base64 with or without its padding, unused bits ignored — or undefined when
 *  it is not that encoding at all. */
function decodeKeyLeniently(text: string, encoding: KeyEncoding): Uint8Array | undefined {
  if (encoding === "hex") {
    if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return undefined;
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
    return out;
  }
  const alphabet = alphabetOf(encoding);
  const body = text.replace(/={1,2}$/, "");
  if (body.length % 4 === 1) return undefined;
  if (body.length !== text.length && text.length % 4 !== 0) return undefined;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of body) {
    const value = alphabet.indexOf(character);
    if (value < 0) return undefined;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

const CANONICAL_RULE: Record<KeyEncoding, string> = {
  base64url: "no '=' padding, and the unused bits of its last character zero",
  "base64url-padded": "'=' padding to a multiple of four characters, and the unused bits of its last character zero",
  base64: "'=' padding to a multiple of four characters, and the unused bits of its last character zero",
  hex: "lowercase hex digits",
};

/**
 * Why a value supplied for a generated need's field breaks its parameters, as
 * a predicate on the value (`does not decode as base64url to 32 bytes`), or
 * undefined when it holds them. A key decodes under `encoding` to exactly
 * `bytes` bytes and is that encoding's canonical text; a password is exactly
 * `length` characters of the union of its sets, each set's `minimum` met. The
 * sentence never quotes the value. Undefined as well for parameters the type
 * refuses, which `NEED_PARAMETERS_INVALID` reports.
 */
export function generatedValueRefusal(type: string, parameters: unknown, value: unknown): string | undefined {
  if (type === GENERATED_SECRET_KEY_TYPE) {
    const wanted = generatedKeyParameters(parameters);
    if (!wanted) return undefined;
    if (typeof value !== "string") return "is not a string";
    const bytes = decodeKeyLeniently(value, wanted.encoding);
    if (!bytes || bytes.length !== wanted.bytes) {
      return `does not decode as ${wanted.encoding} to ${wanted.bytes} bytes`;
    }
    if (encodeKey(bytes, wanted.encoding) !== value) {
      return (
        `decodes as ${wanted.encoding} to ${wanted.bytes} bytes but is not that encoding's ` +
        `canonical text — ${CANONICAL_RULE[wanted.encoding]}`
      );
    }
    return undefined;
  }
  if (type === GENERATED_PASSWORD_TYPE) {
    const wanted = generatedCharacterRules(parameters);
    if (!wanted) return undefined;
    if (typeof value !== "string") return "is not a string";
    const characters = [...value];
    if (characters.length !== wanted.length) return `is not exactly ${wanted.length} characters`;
    const union = new Set(wanted.characterSets.flatMap((set) => [...set.characters]));
    if (characters.some((character) => !union.has(character))) {
      return "holds a character outside its character sets";
    }
    for (const [i, set] of wanted.characterSets.entries()) {
      const members = new Set(set.characters);
      const count = characters.filter((character) => members.has(character)).length;
      if (count < set.minimum) {
        return `holds fewer than ${set.minimum} character${set.minimum === 1 ? "" : "s"} of characterSets[${i}]`;
      }
    }
    return undefined;
  }
  return undefined;
}
