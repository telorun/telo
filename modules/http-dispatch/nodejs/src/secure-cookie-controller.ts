import { CookieDeclaration, sharedAttributes, type CookieManifest } from "./cookie-declaration.js";

export function register(): void {}

/** `__Secure-<name>`: Secure, its own domain and path. */
export async function create(resource: CookieManifest): Promise<CookieDeclaration> {
  return new CookieDeclaration({
    name: `__Secure-${resource.name}`,
    ...sharedAttributes(resource),
    secure: true,
    domain: resource.domain ?? null,
    path: resource.path ?? "/",
  });
}
