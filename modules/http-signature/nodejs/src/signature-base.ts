import { DERIVED_COMPONENTS, derivedValue } from "./derived-components.js";
import { headerValue, type RequestDescription } from "./request-description.js";
import { SignatureMalformed } from "./signature-failure.js";
import { parseItem, serializeItem, type Item } from "./structured-fields.js";

/** Component parameters this implementation does not evaluate. */
const UNSUPPORTED_PARAMS = new Set(["sf", "bs", "key", "req", "tr"]);

function componentName(item: Item): string {
  if (item.value.type !== "string") throw new SignatureMalformed("a covered component is not a string");
  return item.value.value;
}

/** Judges a covered component and answers its identifier text, throwing when it cannot be evaluated. */
export function checkComponent(item: Item): string {
  const name = componentName(item);
  for (const [key] of item.params) {
    if (UNSUPPORTED_PARAMS.has(key)) throw new SignatureMalformed(`component ${JSON.stringify(name)} uses the unsupported parameter ;${key}`);
    if (key !== "name" || name !== "@query-param") throw new SignatureMalformed(`component ${JSON.stringify(name)} carries the parameter ;${key}`);
  }
  if (name === "@signature-params" || name === "@status") {
    throw new SignatureMalformed(`component ${JSON.stringify(name)} cannot be covered by a request signature`);
  }
  if (name.startsWith("@")) {
    if (!DERIVED_COMPONENTS.has(name)) throw new SignatureMalformed(`the derived component ${JSON.stringify(name)} is not supported`);
    if (name === "@query-param" && !item.params.some(([key, v]) => key === "name" && v.type === "string")) {
      throw new SignatureMalformed("@query-param names no parameter");
    }
  } else if (name !== name.toLowerCase() || name === "") {
    throw new SignatureMalformed(`header component ${JSON.stringify(name)} is not a lower-case field name`);
  }
  return serializeItem(item);
}

/**
 * The signature base of RFC 9421 §2.5: one line per covered component, then the
 * `@signature-params` line holding the serialized parameters.
 */
export function buildSignatureBase(request: RequestDescription, components: Item[], signatureParams: string): Uint8Array {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of components) {
    const id = checkComponent(item);
    if (seen.has(id)) throw new SignatureMalformed(`component ${id} is covered twice`);
    seen.add(id);
    const name = componentName(item);
    let value: string;
    if (name.startsWith("@")) {
      const nameParam = item.params.find(([key]) => key === "name")?.[1];
      value = derivedValue(name, request, nameParam?.type === "string" ? nameParam.value : undefined);
    } else {
      const header = headerValue(request.headers, name);
      if (header === undefined) throw new SignatureMalformed(`the request has no ${name} header the signature covers`);
      value = header;
    }
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${signatureParams}`);
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * A component a receiver requires, written as `@method`, `content-digest` or
 * `@query-param;name="x"`, in the identifier text a signature's component has.
 */
export function requiredComponentId(text: string): string {
  const match = /^([^;]*)(;.*)?$/.exec(text)!;
  let item: Item;
  try {
    item = parseItem(`${JSON.stringify(match[1])}${match[2] ?? ""}`);
  } catch (error) {
    throw new Error(`component ${JSON.stringify(text)} is not a component identifier: ${(error as Error).message}`);
  }
  try {
    return checkComponent(item);
  } catch (error) {
    throw new Error(`component ${JSON.stringify(text)}: ${(error as Error).message}`);
  }
}
