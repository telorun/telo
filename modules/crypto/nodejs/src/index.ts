// The code library (`exports.code: @telorun/crypto`): the same operations as
// functions, for sibling controllers to call in-process.
export { decodeBytes, encodeBytes, toBytes } from "./byte-encoding.js";
export type { ByteEncoding, CryptoInput } from "./byte-encoding.js";
export {
  constantTimeEqual,
  deriveKey,
  digest,
  hmacSign,
  hmacVerify,
  randomValue,
} from "./primitives.js";
export type { DigestAlgorithm } from "./primitives.js";
export { hashPassword, verifyPassword } from "./password-hash.js";
export type {
  PasswordAlgorithm,
  PasswordParameters,
  PasswordPolicy,
  PasswordVerdict,
} from "./password-hash.js";

// Controller entry points, one per kind, selected by PURL fragment.
export * as RandomController from "./random-controller.js";
export * as DigestController from "./digest-controller.js";
export * as HmacController from "./hmac-controller.js";
export * as PasswordHashController from "./password-hash-controller.js";
export * as CompareController from "./compare-controller.js";
export * as DeriveKeyController from "./derive-key-controller.js";
