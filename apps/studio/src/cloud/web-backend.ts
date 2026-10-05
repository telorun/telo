import { isCloudIdentity, type CloudSessionSource, type CloudSessionState } from "./session";
import { CloudUnreachableError, type CloudRequest, type CloudTransport } from "./transport";

/** The API on Studio's own origin: same-origin requests carry the HttpOnly
 *  session cookie by themselves, so nothing here depends on CORS. */
const API_BASE = "/api";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The web build's Cloud backend. The only thing JavaScript holds is the CSRF
 * token the session read answers with — proof that this page read the session,
 * useless without the cookie the browser keeps to itself.
 */
export class WebCloudBackend implements CloudTransport, CloudSessionSource {
  private csrfToken: string | null = null;

  async request(request: CloudRequest): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    if (request.body !== undefined) headers["content-type"] ??= "application/json";
    if (!SAFE_METHODS.has(request.method.toUpperCase()) && this.csrfToken) {
      headers["x-csrf-token"] = this.csrfToken;
    }
    try {
      return await fetch(API_BASE + request.path, {
        method: request.method,
        headers,
        body: request.body,
        credentials: "same-origin",
      });
    } catch (err) {
      throw new CloudUnreachableError(err instanceof Error ? err.message : String(err));
    }
  }

  async read(): Promise<CloudSessionState> {
    let response: Response;
    try {
      response = await this.request({ method: "GET", path: "/session" });
    } catch {
      // No answer at all is an origin with nothing behind `/api`.
      return { status: "unavailable" };
    }
    // The dev server answers every path with 200 and the page itself, so the
    // status alone says nothing: only JSON of the right shape counts.
    const body = await readJson(response);
    if (response.status === 200 && isCloudIdentity(body)) {
      const csrfToken = (body as { csrfToken?: unknown }).csrfToken;
      if (typeof csrfToken !== "string") return { status: "unavailable" };
      this.csrfToken = csrfToken;
      const { user, org, permissions, expiresAt } = body;
      return { status: "signedIn", identity: { user, org, permissions, expiresAt } };
    }
    this.csrfToken = null;
    if (response.status === 401 && (body as { code?: unknown } | null)?.code === "session_required") {
      return { status: "anonymous" };
    }
    return { status: "unavailable" };
  }

  /** A full-page navigation: Cloud redirects to the identity provider and back
   *  to `returnTo`, and Studio restores its tabs as it does after a reload. */
  signIn(): Promise<CloudSessionState> {
    const here = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(`${API_BASE}/session/login?returnTo=${encodeURIComponent(here)}`);
    return new Promise(() => undefined);
  }

  /** The same navigation: the identity provider's organization picker decides. */
  switchOrganization(): Promise<CloudSessionState> {
    return this.signIn();
  }

  async signOut(): Promise<void> {
    const response = await this.request({ method: "POST", path: "/session/logout" });
    const body = await readJson(response);
    const location = (body as { location?: unknown } | null)?.location;
    if (!response.ok || typeof location !== "string") {
      throw new Error(`Sign-out failed (HTTP ${response.status}).`);
    }
    this.csrfToken = null;
    window.location.assign(location);
    return new Promise(() => undefined);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}
