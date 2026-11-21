import { hkdfSync } from "node:crypto";
import { SECRET_SEED_BYTES, type SecretSeed } from "./seed-encoding.js";

/** HKDF-SHA256 over the seed, empty salt, the label's UTF-8 bytes as info, 32 bytes. */
export function deriveChildSeed(seed: SecretSeed, label: string): SecretSeed {
  return new Uint8Array(
    hkdfSync("sha256", seed, new Uint8Array(0), Buffer.from(label, "utf8"), SECRET_SEED_BYTES),
  );
}
