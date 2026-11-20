/**
 * The OSV endpoint `telo audit` asks: `--osv-url` over `TELO_OSV_URL` over the
 * default. A value that is not an http or https URL refuses the invocation.
 */

import { DEFAULT_OSV_URL } from "@telorun/osv";

export const OSV_URL_ENV = "TELO_OSV_URL";

export type OsvEndpoint =
  | { readonly ok: true; readonly url: string; readonly isDefault: boolean }
  | { readonly ok: false; readonly message: string };

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveOsvEndpoint(flag: string | undefined, env: NodeJS.ProcessEnv): OsvEndpoint {
  const fromEnv = env[OSV_URL_ENV];
  const [value, name] =
    flag !== undefined ? [flag, "--osv-url"] : fromEnv !== undefined && fromEnv !== "" ? [fromEnv, OSV_URL_ENV] : [undefined, ""];
  if (value === undefined) return { ok: true, url: DEFAULT_OSV_URL, isDefault: true };
  if (!isHttpUrl(value)) {
    return { ok: false, message: `Invalid value for ${name}: "${value}" is not an http or https URL.` };
  }
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  const url = value.slice(0, end);
  return { ok: true, url, isDefault: url === DEFAULT_OSV_URL };
}
