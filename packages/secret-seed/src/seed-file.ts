import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeSecretSeed,
  encodeSecretSeed,
  generateSecretSeed,
  type SecretSeed,
} from "./seed-encoding.js";

export const SECRET_SEED_FILE_NAME = "secret-seed";

function readSeedFile(path: string): SecretSeed {
  const text = readFileSync(path, "utf8");
  return decodeSecretSeed(text.endsWith("\n") ? text.slice(0, -1) : text, { file: path });
}

/**
 * Reads the seed file at `path`, creating it with a fresh seed when absent. An existing
 * file is never overwritten; one that does not decode refuses naming `path`.
 */
export function readOrCreateSecretSeedFile(path: string): SecretSeed {
  try {
    return readSeedFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const seed = generateSecretSeed();
  const text = `${encodeSecretSeed(seed)}\n`;
  // Written whole to a private temporary file, then linked into place: the link is the
  // exclusive create, and no reader ever sees the file empty.
  const temporary = join(dirname(path), `.${SECRET_SEED_FILE_NAME}.${randomBytes(6).toString("hex")}`);
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, path);
    return seed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return readSeedFile(path);
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw error;
  } finally {
    unlinkSync(temporary);
  }
  // A filesystem without hard links: an exclusive create directly.
  try {
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    return seed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readSeedFile(path);
    throw error;
  }
}
