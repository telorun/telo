import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { isAbsoluteHostPath } from "@telorun/sdk";

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
  // An int / uint is a BigInt here and serializes as its exact digits — see
  // `enableBigIntJson` in `@telorun/sdk`, installed at boot. JSON.stringify
  // returns undefined for top-level undefined / function / symbol — the CEL
  // signature is `json(dyn): string`, so coerce that to "null" rather than break
  // the contract. (CEL `null` already serializes to "null".)
  json: (value: unknown) => JSON.stringify(value) ?? "null",
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
