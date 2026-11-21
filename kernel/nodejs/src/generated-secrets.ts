import {
  encodeKey,
  GENERATED_SECRET_KEY_TYPE,
  generatedKeyParameters,
  generatedCharacterRules,
  generatedSecretField,
  generatedSecretInfo,
  generatedValueRefusal,
  isGeneratedSecretType,
  needParametersWithDefaults,
  SECRET_SEED_HOST_VALUE,
  type NeedEnvironmentEntry,
  type NeedTypeShape,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { decodeSecretSeed, SecretSeedError, type SecretSeed } from "@telorun/secret-seed";
import { createHmac } from "node:crypto";

/**
 * The kernel half of `Telo.GeneratedSecretKey` / `Telo.GeneratedPassword`:
 * deriving a need's value from the host's secret seed, and refusing a supplied
 * value its need's parameters reject. What a manifest is held to statically —
 * the parameters, a literal value — is the analyzer's (`generated-secret.ts`,
 * the need table). Shared vectors: `kernel/generated-secret-conformance/`.
 */

/**
 * The byte stream a value is drawn from: PRK = HKDF-SHA256-Extract(empty salt,
 * seed), block i = HKDF-Expand(PRK, info ‖ 0x00 ‖ uint32be(i), 32), the blocks
 * in order. One expand of 32 bytes is one HMAC over its info and the counter 1.
 */
class DerivationStream {
  private readonly prk: Buffer;
  private readonly info: Buffer;
  private block = 0;
  private buffered = Buffer.alloc(0);

  constructor(seed: SecretSeed, info: string) {
    this.prk = createHmac("sha256", Buffer.alloc(0)).update(seed).digest();
    this.info = Buffer.from(info, "utf8");
  }

  take(count: number): Buffer {
    while (this.buffered.length < count) {
      const suffix = Buffer.alloc(5);
      suffix.writeUInt32BE(this.block++, 1);
      const next = createHmac("sha256", this.prk)
        .update(this.info)
        .update(suffix)
        .update(Buffer.from([1]))
        .digest();
      this.buffered = Buffer.concat([this.buffered, next]);
    }
    const out = this.buffered.subarray(0, count);
    this.buffered = this.buffered.subarray(count);
    return out;
  }

  /** A uniform integer in [0, m): two bytes as a big-endian v, accepted below
   *  the largest multiple of m that fits, drawn again otherwise. */
  draw(m: number): number {
    const limit = 65536 - (65536 % m);
    for (;;) {
      const v = this.take(2).readUInt16BE(0);
      if (v < limit) return v % m;
    }
  }
}

/**
 * The value a generated need of `type` at `path` takes under `seed` — a pure
 * function of the four, so it is the same on every restart, reload and resume.
 * `parameters` are the outermost need's, defaults filled; they have passed the
 * need table, so a reading the type refuses is an invariant failure.
 */
export function deriveGeneratedSecret(
  seed: SecretSeed,
  type: string,
  path: readonly string[],
  parameters: unknown,
): string {
  const info = generatedSecretInfo(type, path, parameters);
  if (info === undefined) {
    throw new RuntimeError("ERR_FATAL", `need '${path.join(".")}' reached the derivation with parameters ${type} refuses.`);
  }
  const stream = new DerivationStream(seed, info);
  if (type === GENERATED_SECRET_KEY_TYPE) {
    const key = generatedKeyParameters(parameters)!;
    return encodeKey(new Uint8Array(stream.take(key.bytes)), key.encoding);
  }
  const rules = generatedCharacterRules(parameters)!;
  const out: string[] = [];
  for (const set of rules.characterSets) {
    for (let i = 0; i < set.minimum; i++) out.push(set.characters[stream.draw(set.characters.length)]!);
  }
  const union = rules.characterSets.map((set) => set.characters).join("");
  while (out.length < rules.length) out.push(union[stream.draw(union.length)]!);
  for (let i = rules.length - 1; i >= 1; i--) {
    const j = stream.draw(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.join("");
}

/** The seed the host set, decoded, or undefined when it set none; a value that
 *  is not 32 bytes of unpadded base64url is refused naming the variable, never
 *  the value. */
function hostSecretSeed(env: Record<string, string | undefined>): SecretSeed | undefined {
  const text = env[SECRET_SEED_HOST_VALUE];
  if (text === undefined || text === "") return undefined;
  try {
    return decodeSecretSeed(text, { variable: SECRET_SEED_HOST_VALUE });
  } catch (error) {
    if (error instanceof SecretSeedError) throw new RuntimeError("ERR_NEED_HOST_VALUE_INVALID", error.message);
    throw error;
  }
}

/**
 * Every generated need the environment leaves unset that the host's seed
 * answers, as the env name of its field and the value it derives. The seed is
 * read only when such a need exists, so a malformed one refuses only a load
 * that would use it.
 */
export function generatedSecretAnswers(
  entries: readonly NeedEnvironmentEntry[],
  env: Record<string, string | undefined>,
  shapeOf: (entry: NeedEnvironmentEntry) => NeedTypeShape | undefined,
): Map<string, string> {
  const answers = new Map<string, string>();
  const unset = entries.filter((entry) => {
    const field = entry.fields?.[generatedSecretField(entry.need.type) ?? ""];
    return field !== undefined && (env[field.env] === undefined || env[field.env] === "");
  });
  if (unset.length === 0) return answers;
  const seed = hostSecretSeed(env);
  if (seed === undefined) return answers;
  for (const entry of unset) {
    const type = entry.need.type!;
    const field = entry.fields[generatedSecretField(type)!]!;
    const parameters = needParametersWithDefaults(shapeOf(entry), entry.need.parameters);
    answers.set(field.env, deriveGeneratedSecret(seed, type, entry.path, parameters));
  }
  return answers;
}

/**
 * Why a value supplied for a generated need's field breaks the need's
 * parameters — `<subject>: <source> <rule>`, never quoting the value — or
 * undefined when it holds them, or the type is not a generated one.
 */
export function generatedValueProblem(
  type: string | undefined,
  shape: NeedTypeShape | undefined,
  parameters: unknown,
  fields: Readonly<Record<string, unknown>>,
  describe: (field: string) => string,
): string | undefined {
  if (!type || !isGeneratedSecretType(type)) return undefined;
  const field = generatedSecretField(type)!;
  if (fields[field] === undefined) return undefined;
  const rule = generatedValueRefusal(type, needParametersWithDefaults(shape, parameters), fields[field]);
  return rule === undefined ? undefined : `${describe(field)} ${rule}`;
}

/** {@link generatedValueProblem} as the refusal a fulfilment's supplier raises. */
export function refuseGeneratedValue(
  subject: string,
  type: string | undefined,
  shape: NeedTypeShape | undefined,
  parameters: unknown,
  fields: Readonly<Record<string, unknown>>,
  describe: (field: string) => string,
): void {
  const problem = generatedValueProblem(type, shape, parameters, fields, describe);
  if (problem) throw new RuntimeError("ERR_NEED_VALUE_INVALID", `${subject} (type '${type}'): ${problem}.`);
}

