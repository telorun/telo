import { createHmac, pbkdf2, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { argon2d, argon2i, argon2id, bcrypt, bcryptVerify } from "hash-wasm";
import { InvokeError } from "@telorun/sdk";
import { toBytes, type CryptoInput } from "./byte-encoding.js";

const pbkdf2Async = promisify(pbkdf2);
const scryptAsync = promisify(scrypt) as (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export type PasswordAlgorithm = "argon2id" | "bcrypt" | "scrypt" | "pbkdf2";

export interface PasswordParameters {
  argon2id?: { memoryKiB?: number; iterations?: number; parallelism?: number };
  bcrypt?: { cost?: number };
  scrypt?: { cost?: number; blockSize?: number; parallelization?: number };
  pbkdf2?: { iterations?: number };
}

export interface PasswordPolicy {
  algorithm: PasswordAlgorithm;
  parameters?: PasswordParameters;
  /** Applied as HMAC-SHA256 of the password before hashing. */
  pepper?: CryptoInput;
}

export interface PasswordVerdict {
  valid: boolean;
  rehash: boolean;
}

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const BCRYPT_MAX_BYTES = 72;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/=+$/, "");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

interface ResolvedParameters {
  argon2id: { memoryKiB: number; iterations: number; parallelism: number };
  bcrypt: { cost: number };
  scrypt: { cost: number; blockSize: number; parallelization: number };
  pbkdf2: { iterations: number };
}

function resolveParameters(given: PasswordParameters = {}): ResolvedParameters {
  return {
    argon2id: { memoryKiB: 19456, iterations: 2, parallelism: 1, ...given.argon2id },
    bcrypt: { cost: 12, ...given.bcrypt },
    scrypt: { cost: 131072, blockSize: 8, parallelization: 1, ...given.scrypt },
    pbkdf2: { iterations: 600000, ...given.pbkdf2 },
  };
}

/** What a stored hash says about itself. */
type Parsed =
  | {
      algorithm: "argon2id" | "argon2i" | "argon2d";
      memoryKiB: number;
      iterations: number;
      parallelism: number;
      salt: Uint8Array;
      key: Uint8Array;
    }
  | { algorithm: "bcrypt"; cost: number }
  | {
      algorithm: "scrypt";
      cost: number;
      blockSize: number;
      parallelization: number;
      salt: Uint8Array;
      key: Uint8Array;
    }
  | {
      algorithm: "pbkdf2";
      digest: "sha256" | "sha512";
      iterations: number;
      salt: Uint8Array;
      key: Uint8Array;
    }
  | { algorithm: "malformed" };

const MALFORMED: Parsed = { algorithm: "malformed" };
const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 1024;
const MIN_SALT_BYTES = 8;
const BASE64_TEXT = /^[A-Za-z0-9+/]+$/;

function unsupported(): InvokeError {
  return new InvokeError(
    "ERR_CRYPTO_UNSUPPORTED_HASH",
    "The stored hash is in an encoding this module does not know (argon2, bcrypt, scrypt and pbkdf2 are).",
  );
}

function tooLong(): InvokeError {
  return new InvokeError(
    "ERR_PASSWORD_TOO_LONG",
    `bcrypt reads only the first ${BCRYPT_MAX_BYTES} bytes of a password; refusing a longer one instead of silently truncating it.`,
  );
}

/** A decimal count of at least `min` that a number holds exactly. */
function count(text: string | undefined, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  if (text === undefined || !/^\d{1,15}$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function field(text: string | undefined, minBytes: number, maxBytes: number): Uint8Array | null {
  if (text === undefined || !BASE64_TEXT.test(text)) return null;
  const bytes = unb64(text);
  return bytes.length >= minBytes && bytes.length <= maxBytes ? bytes : null;
}

/** `name=value` pairs in exactly the stated order; anything else is null. */
function orderedParameters(text: string, names: string[]): string[] | null {
  const pairs = text.split(",");
  if (pairs.length !== names.length) return null;
  const values: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const [name, value, ...rest] = pairs[i].split("=");
    if (name !== names[i] || value === undefined || rest.length > 0) return null;
    values.push(value);
  }
  return values;
}

function parseArgon2(hash: string, algorithm: "argon2id" | "argon2i" | "argon2d"): Parsed {
  const match = /^\$argon2(?:id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]*)\$([^$]*)$/.exec(hash);
  if (!match || match[1] !== "19") return MALFORMED;
  const parallelism = count(match[4], 1, 0xffffff);
  const memoryKiB = count(match[2], 8, 0xffffffff);
  const iterations = count(match[3], 1, 0xffffffff);
  const salt = field(match[5], MIN_SALT_BYTES, MAX_KEY_BYTES);
  const key = field(match[6], MIN_KEY_BYTES, MAX_KEY_BYTES);
  if (parallelism === null || memoryKiB === null || iterations === null || !salt || !key) {
    return MALFORMED;
  }
  if (memoryKiB < 8 * parallelism) return MALFORMED;
  return { algorithm, memoryKiB, iterations, parallelism, salt, key };
}

function parse(hash: string): Parsed {
  if (hash.startsWith("$argon2id$")) return parseArgon2(hash, "argon2id");
  if (hash.startsWith("$argon2i$")) return parseArgon2(hash, "argon2i");
  if (hash.startsWith("$argon2d$")) return parseArgon2(hash, "argon2d");
  const bcryptMatch = /^\$2[abxy]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(hash);
  if (bcryptMatch) return { algorithm: "bcrypt", cost: Number(bcryptMatch[1]) };
  const parts = hash.split("$");
  if (parts[0] !== "") throw unsupported();
  if (parts[1] === "scrypt" && parts.length === 5) {
    const values = orderedParameters(parts[2], ["ln", "r", "p"]);
    if (!values) return MALFORMED;
    const ln = count(values[0], 1, 30);
    const blockSize = count(values[1], 1, 0x3fffffff);
    const parallelization = count(values[2], 1, 0x3fffffff);
    const salt = field(parts[3], 1, MAX_KEY_BYTES);
    const key = field(parts[4], MIN_KEY_BYTES, MAX_KEY_BYTES);
    if (ln === null || blockSize === null || parallelization === null || !salt || !key) {
      return MALFORMED;
    }
    if (blockSize * parallelization >= 2 ** 30) return MALFORMED;
    return { algorithm: "scrypt", cost: 2 ** ln, blockSize, parallelization, salt, key };
  }
  if ((parts[1] === "pbkdf2-sha256" || parts[1] === "pbkdf2-sha512") && parts.length === 5) {
    const values = orderedParameters(parts[2], ["i"]);
    if (!values) return MALFORMED;
    const iterations = count(values[0], 1, 0x7fffffff);
    const salt = field(parts[3], 1, MAX_KEY_BYTES);
    const key = field(parts[4], MIN_KEY_BYTES, MAX_KEY_BYTES);
    if (iterations === null || !salt || !key) return MALFORMED;
    return {
      algorithm: "pbkdf2",
      digest: parts[1] === "pbkdf2-sha256" ? "sha256" : "sha512",
      iterations,
      salt,
      key,
    };
  }
  throw unsupported();
}

/** The bytes handed to the algorithm: the password, or its pepper MAC. */
function material(password: CryptoInput, pepper: CryptoInput | undefined): Uint8Array {
  const bytes = toBytes(password);
  if (pepper === undefined) return bytes;
  return new Uint8Array(
    Buffer.from(createHmac("sha256", toBytes(pepper)).update(bytes).digest("base64")),
  );
}

function log2(n: number): number {
  const ln = Math.log2(n);
  if (!Number.isInteger(ln)) {
    throw new InvokeError("ERR_INPUT_INVALID", "scrypt cost must be a power of two.");
  }
  return ln;
}

function scryptKey(
  input: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  keyBytes = KEY_BYTES,
) {
  return scryptAsync(input, salt, keyBytes, { N, r, p, maxmem: 128 * N * r * 2 + 64 * 1024 * 1024 });
}

export async function hashPassword(password: CryptoInput, policy: PasswordPolicy): Promise<string> {
  const input = material(password, policy.pepper);
  const parameters = resolveParameters(policy.parameters);
  const salt = randomBytes(SALT_BYTES);
  switch (policy.algorithm) {
    case "argon2id": {
      const { memoryKiB, iterations, parallelism } = parameters.argon2id;
      return argon2id({
        password: input,
        salt,
        parallelism,
        iterations,
        memorySize: memoryKiB,
        hashLength: KEY_BYTES,
        outputType: "encoded",
      });
    }
    case "bcrypt":
      if (input.length > BCRYPT_MAX_BYTES) throw tooLong();
      return bcrypt({
        password: input,
        salt,
        costFactor: parameters.bcrypt.cost,
        outputType: "encoded",
      });
    case "scrypt": {
      const { cost, blockSize, parallelization } = parameters.scrypt;
      const ln = log2(cost);
      const key = await scryptKey(input, salt, cost, blockSize, parallelization);
      return `$scrypt$ln=${ln},r=${blockSize},p=${parallelization}$${b64(salt)}$${b64(key)}`;
    }
    case "pbkdf2": {
      const { iterations } = parameters.pbkdf2;
      const key = await pbkdf2Async(input, salt, iterations, KEY_BYTES, "sha256");
      return `$pbkdf2-sha256$i=${iterations}$${b64(salt)}$${b64(key)}`;
    }
  }
}

function weaker(parsed: Parsed, policy: PasswordPolicy): boolean {
  const configured = resolveParameters(policy.parameters);
  if (parsed.algorithm !== policy.algorithm) return true;
  switch (parsed.algorithm) {
    case "argon2id":
      return (
        parsed.memoryKiB < configured.argon2id.memoryKiB ||
        parsed.iterations < configured.argon2id.iterations
      );
    case "bcrypt":
      return parsed.cost < configured.bcrypt.cost;
    case "scrypt":
      return (
        parsed.cost < configured.scrypt.cost ||
        parsed.blockSize < configured.scrypt.blockSize ||
        parsed.parallelization < configured.scrypt.parallelization
      );
    case "pbkdf2":
      return parsed.digest !== "sha256" || parsed.iterations < configured.pbkdf2.iterations;
    default:
      return true;
  }
}

async function matches(parsed: Parsed, hash: string, input: Uint8Array): Promise<boolean> {
  switch (parsed.algorithm) {
    case "argon2id":
    case "argon2i":
    case "argon2d": {
      const derive = { argon2id, argon2i, argon2d }[parsed.algorithm];
      const key = await derive({
        password: input,
        salt: parsed.salt,
        parallelism: parsed.parallelism,
        iterations: parsed.iterations,
        memorySize: parsed.memoryKiB,
        hashLength: parsed.key.length,
        outputType: "binary",
      });
      return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
    }
    case "bcrypt":
      if (input.length > BCRYPT_MAX_BYTES) throw tooLong();
      return bcryptVerify({ password: input, hash });
    case "scrypt": {
      const key = await scryptKey(
        input,
        parsed.salt,
        parsed.cost,
        parsed.blockSize,
        parsed.parallelization,
        parsed.key.length,
      );
      return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
    }
    case "pbkdf2": {
      const key = await pbkdf2Async(
        input,
        parsed.salt,
        parsed.iterations,
        parsed.key.length,
        parsed.digest,
      );
      return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
    }
    default:
      return false;
  }
}

/**
 * Verifies against any encoding the module knows, whatever the policy.
 * `rehash` is true for a valid password whose stored hash is weaker than the policy.
 */
export async function verifyPassword(
  password: CryptoInput,
  hash: string,
  policy: PasswordPolicy,
): Promise<PasswordVerdict> {
  const parsed = parse(hash);
  if (parsed.algorithm === "malformed") return { valid: false, rehash: false };
  const valid = await matches(parsed, hash, material(password, policy.pepper));
  return { valid, rehash: valid && weaker(parsed, policy) };
}
