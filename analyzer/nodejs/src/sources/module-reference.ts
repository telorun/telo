import { splitIntegrity } from "./integrity.js";
import { isLocalPathSource } from "./local-path-ref.js";
import { OCI_SCHEME, parseOciRef } from "./oci-ref.js";

/** How the scheme `source` names reads it: an `oci://` ref by the OCI ref
 *  grammar, an http(s) URL by the WHATWG URL parser. `unclaimed` for text no
 *  such scheme names. */
function schemedReading(source: string): "well-formed" | "malformed" | "unclaimed" {
  const { base } = splitIntegrity(source);
  if (base.startsWith(OCI_SCHEME)) return readsAsOciRef(source) ? "well-formed" : "malformed";
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return URL.canParse(base) ? "well-formed" : "malformed";
  }
  return "unclaimed";
}

function readsAsOciRef(source: string): boolean {
  try {
    parseOciRef(source);
    return true;
  } catch {
    return false;
  }
}

/** True when `source` is a module reference: a path, or an `oci://` / http(s)
 *  reference its scheme's own grammar reads. Decided from the text alone, before
 *  anything is fetched. */
export function isModuleReference(source: string): boolean {
  return isLocalPathSource(source) || schemedReading(source) === "well-formed";
}

/** True when `source` names the `oci://` or an http(s) scheme and that scheme's
 *  grammar refuses it: no transport can obtain anything for it, so it is refused
 *  as no module reference before any is asked. */
export function isMalformedSchemedReference(source: string): boolean {
  return schemedReading(source) === "malformed";
}
