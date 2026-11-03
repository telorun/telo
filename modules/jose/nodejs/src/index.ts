// The code library (`exports.code: @telorun/jose`): the key-set instance
// contract, for a sibling controller holding a `Jose.Keys` through a reference
// slot, and the verification every `Jose.Verify` performs.
export {
  ERR_JOSE_ALGORITHM_UNSUPPORTED,
  ERR_JOSE_KEYSET_UNAVAILABLE,
  ERR_JOSE_REMOTE_KEYS_UNREACHABLE,
  isJoseKeys,
  isJoseKeySet,
} from "./key-set-contract.js";
export type {
  JoseKeys,
  JoseKeySet,
  JsonWebKeySet,
  KeyHint,
  KeyMaterial,
  RotationOutcome,
  SigningKey,
} from "./key-set-contract.js";
export { verifyToken } from "./token-verification.js";
export type { RefusalReason, VerifyOutcome, VerifyPolicy } from "./token-verification.js";

// Controller entry points, one per kind, selected by PURL fragment.
export * as KeySetController from "./key-set-controller.js";
export * as RemoteKeySetController from "./remote-key-set-controller.js";
export * as SignController from "./sign-controller.js";
export * as VerifyController from "./verify-controller.js";
export * as RotateController from "./rotate-controller.js";
export * as PublicKeysController from "./public-keys-controller.js";
export * as EncryptController from "./encrypt-controller.js";
export * as DecryptController from "./decrypt-controller.js";
