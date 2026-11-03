import type { ResourceInstance } from "@telorun/sdk";
import type { CookieAttributes } from "./cookie.js";

/** What every cookie kind declares, as the manifest hands it over: the kernel
 *  validates a copy, so an omitted attribute arrives absent, not defaulted. */
export interface CookieManifest {
  readonly name: string;
  readonly httpOnly?: boolean;
  readonly sameSite?: CookieAttributes["sameSite"];
  readonly partitioned?: boolean;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
}

/** The attributes every cookie kind shares, with the abstract's defaults filled. */
export function sharedAttributes(manifest: CookieManifest) {
  return {
    httpOnly: manifest.httpOnly ?? true,
    sameSite: manifest.sameSite ?? "Lax",
    partitioned: manifest.partitioned ?? false,
  } as const;
}

/** A cookie declaration: it publishes its normalized attributes and does nothing else. */
export class CookieDeclaration implements ResourceInstance {
  constructor(private readonly attributes: CookieAttributes) {}

  snapshot(): Record<string, unknown> {
    return { ...this.attributes };
  }
}
