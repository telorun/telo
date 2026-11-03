import { CookieDeclaration, sharedAttributes, type CookieManifest } from "./cookie-declaration.js";

export function register(): void {}

/** `__Host-<name>`: Secure, `Path=/`, no `Domain`. */
export async function create(resource: CookieManifest): Promise<CookieDeclaration> {
  return new CookieDeclaration({
    name: `__Host-${resource.name}`,
    ...sharedAttributes(resource),
    secure: true,
    domain: null,
    path: "/",
  });
}
