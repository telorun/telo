import { CookieDeclaration, sharedAttributes, type CookieManifest } from "./cookie-declaration.js";

export function register(): void {}

/** The name as written, Secure unless the declaration says otherwise. */
export async function create(resource: CookieManifest): Promise<CookieDeclaration> {
  return new CookieDeclaration({
    name: resource.name,
    ...sharedAttributes(resource),
    secure: resource.secure ?? true,
    domain: resource.domain ?? null,
    path: resource.path ?? "/",
  });
}
