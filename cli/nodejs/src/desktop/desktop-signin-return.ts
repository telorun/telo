import { randomBytes } from "node:crypto";

import type { AdmissionRequest, HostBodyRequest, HostResponse } from "./desktop-admission.js";

/**
 * The armed return of an external sign-in (`kernel/specs/desktop-host.md` §5.9).
 * A navigation a window sends to the system browser arms one return, recording
 * that window; the first request from the browser to a declared callback path
 * uses it up. The host answers that request with its own page and replays it in
 * the window that armed the return, where the cookie is: a GET by navigating
 * there on the app's origin, a form POST by navigating to `/return` on the host
 * origin with a single-use code, which the host answers with a page that submits
 * the stored fields to the app's origin.
 */

export const RETURN_PATH = "/return";
const FORM_TYPE = "application/x-www-form-urlencoded";
export const MAX_RETURN_BODY_BYTES = 64 * 1024;
const DEFAULT_CODE_TTL_MS = 2 * 60_000;

export interface SigninReturnOptions {
  /** The app's origin, `http://127.0.0.1:<port>`. */
  origin: string;
  /** The host's own origin, which serves the page replaying a form POST. */
  hostOrigin: string;
  /** Literal app-relative paths, matched exactly against the raw request path. */
  callbackPaths: readonly string[];
  productName: string;
  focus(window: string): Promise<void>;
  navigate(window: string, url: string): Promise<void>;
  /** Told, with no value, that a return was used or that its replay failed. */
  report(event: "used" | { failed: Error }): void;
  codeTtlMs?: number;
  now?: () => number;
}

interface StoredReturn {
  window: string;
  path: string;
  fields: Array<[string, string]>;
  expires: number;
}

export class SigninReturn {
  private armedWindow?: string;
  private readonly stored = new Map<string, StoredReturn>();
  private readonly callbacks: ReadonlySet<string>;

  constructor(private readonly options: SigninReturnOptions) {
    this.callbacks = new Set(options.callbackPaths);
  }

  /** A navigation `window` sent to the system browser: the one armed return is now its. */
  arm(window: string): void {
    if (window === "" || this.callbacks.size === 0) return;
    this.armedWindow = window;
  }

  /** The window is gone: its armed return and the form codes bound to it go with it. */
  windowClosed(window: string): void {
    if (this.armedWindow === window) this.armedWindow = undefined;
    for (const [code, held] of this.stored) if (held.window === window) this.stored.delete(code);
  }

  /** A request without the window's cookie (or from a foreign origin): the armed return, or nothing. */
  unadmitted(request: AdmissionRequest): HostResponse | HostBodyRequest | undefined {
    const window = this.armedWindow;
    if (window === undefined || !this.callbacks.has(request.path)) return undefined;
    if (request.method === "GET") {
      this.armedWindow = undefined;
      this.replay(window, `${this.options.origin}${request.target}`);
      return this.returnPage();
    }
    if (request.method !== "POST" || !formBody(request)) return undefined;
    // Used up before the body is awaited: a second return cannot take it meanwhile.
    this.armedWindow = undefined;
    return {
      maxBytes: MAX_RETURN_BODY_BYTES,
      onBody: (body) => {
        const code = randomBytes(18).toString("base64url");
        this.sweep();
        this.stored.set(code, {
          window,
          path: request.path,
          fields: [...new URLSearchParams(body.toString("utf8"))],
          expires: this.now() + (this.options.codeTtlMs ?? DEFAULT_CODE_TTL_MS),
        });
        this.replay(window, `${this.options.hostOrigin}${RETURN_PATH}?code=${code}`);
        return this.returnPage();
      },
    };
  }

  /**
   * A request on the host origin carrying the cookie: `GET /return?code=<code>` is
   * the page that submits the stored form to the app's origin, once, for a live
   * code it issued; `undefined` for anything else.
   */
  page(request: AdmissionRequest): HostResponse | undefined {
    if (request.method !== "GET" || request.path !== RETURN_PATH) return undefined;
    const codes = new URLSearchParams(request.query).getAll("code");
    if (codes.length !== 1) return undefined;
    const held = this.stored.get(codes[0]);
    if (!held) return undefined;
    this.stored.delete(codes[0]);
    if (held.expires <= this.now()) return undefined;
    const inputs = held.fields
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    return html(
      `<form method="post" action="${escapeHtml(this.options.origin + held.path)}">${inputs}</form>` +
        "<script>document.forms[0].submit()</script>",
    );
  }

  private replay(window: string, url: string): void {
    this.options.report("used");
    void (async () => {
      try {
        await this.options.focus(window);
        await this.options.navigate(window, url);
      } catch (err) {
        this.options.report({ failed: err as Error });
      }
    })();
  }

  private returnPage(): HostResponse {
    return html(`<p>Return to ${escapeHtml(this.options.productName)} to finish signing in.</p>`);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, held] of this.stored) if (held.expires <= now) this.stored.delete(code);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** Whether the request is a form POST the host will read: the type, and a length present and within the limit. */
function formBody(request: AdmissionRequest): boolean {
  const types = request.headers.get("content-type") ?? [];
  if (types.length !== 1 || types[0].split(";")[0].trim().toLowerCase() !== FORM_TYPE) return false;
  const lengths = request.headers.get("content-length") ?? [];
  return lengths.length === 1 && /^\d{1,9}$/.test(lengths[0]) && Number(lengths[0]) <= MAX_RETURN_BODY_BYTES;
}

function html(body: string): HostResponse {
  return {
    status: 200,
    reason: "OK",
    headers: [
      ["Content-Type", "text/html; charset=utf-8"],
      ["Cache-Control", "no-store"],
      ["Referrer-Policy", "no-referrer"],
    ],
    body,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
