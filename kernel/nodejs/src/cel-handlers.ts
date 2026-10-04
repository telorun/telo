import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { isAbsoluteHostPath, writePlainJson } from "@telorun/sdk";

/** Node implementations of the host-injected CEL functions (`crypto` / `Buffer`).
 *  The kernel wires these into the analyzer + loader; the CLI reuses them for
 *  `telo cel eval` so its results match a real run. */
export const nodeCelHandlers = {
  sha256: (s: string) => createHash("sha256").update(s).digest("hex"),
  md5: (s: string) => createHash("md5").update(s).digest("hex"),
  sha1: (s: string) => createHash("sha1").update(s).digest("hex"),
  sha512: (s: string) => createHash("sha512").update(s).digest("hex"),
  hmac: (algorithm: string, key: string, message: string) =>
    createHmac(algorithm, key).update(message).digest("hex"),
  base64Encode: (s: string) => Buffer.from(s, "utf8").toString("base64"),
  base64Decode: (s: string) => Buffer.from(s, "base64").toString("utf8"),
  // `json(dyn): string` is the JSON text of a CEL value for a reader that is NOT a
  // Telo runtime, which is exactly what the SDK's plain-JSON writer is for — so it
  // writes it, rather than `JSON.stringify` writing whatever the host representation
  // happens to look like. A bare `JSON.stringify` wrote a map as its internals
  // (`json({'a': 1})` answered `{"entries":{}}`), a `uint` as `{"value":"7"}`, bytes
  // as an index-keyed object and an instant as its seconds-and-nanos pair; the writer
  // writes each as the one plain form its type declares — an int64 as its exact
  // digits, a map with non-string keys keyed by each key's text (the protobuf JSON
  // rule), and a key two of them would share as a refusal rather than a dropped entry.
  // `undefined` has no JSON form at all and the signature promises a string, so the
  // contract's `"null"` stands.
  json: (value: unknown) => writePlainJson(value) ?? "null",
  joinPath: joinPathWith(path),
};

/**
 * `joinPath` under a platform's path rules — the host's at runtime (`\` on
 * Windows, `/` elsewhere), so a relative path written with `/` joins into
 * whatever the machine running it uses. An absolute argument is refused on
 * either platform's reading: joining one names nothing under the base.
 */
export function joinPathWith(
  rules: Pick<typeof path, "isAbsolute" | "join">,
): (base: string, relative: string) => string {
  return (base, relative) => {
    if (rules.isAbsolute(relative) || isAbsoluteHostPath(relative)) {
      throw new Error(
        `joinPath('${relative}'): the argument is an absolute path, so joining it names nothing ` +
          `under '${base}'. Pass a path relative to it.`,
      );
    }
    return rules.join(base, relative);
  };
}
