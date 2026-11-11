import { randomBytes } from "node:crypto";
import type * as net from "node:net";

import {
  answerWith,
  carriesCookie,
  hostIs,
  readFirstRequest,
  refuse,
  respond,
  WINDOW_COOKIE,
  type AdmissionRequest,
  type FirstRequest,
  type HeadLimits,
  type HostAnswer,
} from "./desktop-admission.js";

/**
 * The host origin (`kernel/specs/desktop-host.md` §5.5): a loopback listener of
 * the host's own, on which it reads EVERY request itself and closes the connection
 * after answering it. Every page the host shows in a window is served here, never
 * on the application's origin, whose connections the kernel owns once admitted.
 *
 * - `Host` must be exactly `127.0.0.1:<port>` and `Origin` absent or this origin;
 * - `GET /admit?code=<code>` exchanges a single-use code, bound to a window and a
 *   destination, for the `telo-window` cookie: `303` to the destination;
 * - every other request must carry that cookie and is put to {@link HostOriginOptions.page};
 * - everything else is `403`.
 */

export const ADMIT_PATH = "/admit";

export interface HostOriginOptions extends HeadLimits {
  port: number;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** The `telo-window` cookie's value: the per-launch admission secret. */
  secret: string;
  /** A page of the host's own for a request carrying the cookie; `undefined` refuses it. */
  page: (request: AdmissionRequest) => HostAnswer | undefined;
}

interface Admission {
  window: string;
  /** Absolute: where the window goes once it holds the cookie. */
  destination: string;
}

export class DesktopHostOrigin {
  private readonly codes = new Map<string, Admission>();
  private readonly host: string;

  constructor(
    server: net.Server,
    private readonly options: HostOriginOptions,
  ) {
    this.host = `127.0.0.1:${options.port}`;
    server.on("connection", (socket) => readFirstRequest(socket, options, (first) => this.decide(socket, first)));
  }

  /**
   * The first URL of `window`: `/admit` with a fresh single-use code that sends it
   * to `destination`, an absolute URL the host built from an origin, never from a
   * request.
   */
  admissionUrl(window: string, destination: string): string {
    const code = randomBytes(18).toString("base64url");
    this.codes.set(code, { window, destination });
    return `${this.options.origin}${ADMIT_PATH}?code=${code}`;
  }

  /** The window is gone: its unused code goes with it. */
  windowClosed(window: string): void {
    for (const [code, admission] of this.codes) if (admission.window === window) this.codes.delete(code);
  }

  private decide(socket: net.Socket, { request, read, bodyStart }: FirstRequest): void {
    if (!request || !hostIs(request, this.host) || !this.originAllowed(request)) {
      refuse(socket, request?.method);
      return;
    }
    if (request.path === ADMIT_PATH) {
      this.admit(socket, request);
      return;
    }
    const answer = carriesCookie(request, WINDOW_COOKIE, this.options.secret) ? this.options.page(request) : undefined;
    if (answer) answerWith(socket, request, read, bodyStart, answer);
    else refuse(socket, request.method);
  }

  private admit(socket: net.Socket, request: AdmissionRequest): void {
    const given = new URLSearchParams(request.query).getAll("code");
    const admission = request.method === "GET" && given.length === 1 ? this.codes.get(given[0]) : undefined;
    if (!admission) {
      refuse(socket, request.method);
      return;
    }
    this.codes.delete(given[0]);
    respond(socket, request.method, {
      status: 303,
      reason: "See Other",
      headers: [
        ["Location", admission.destination],
        ["Set-Cookie", `${WINDOW_COOKIE}=${this.options.secret}; HttpOnly; SameSite=Strict; Path=/`],
        ["Referrer-Policy", "no-referrer"],
        ["Cache-Control", "no-store"],
      ],
    });
  }

  private originAllowed(request: AdmissionRequest): boolean {
    const origin = request.headers.get("origin") ?? [];
    return origin.length === 0 || (origin.length === 1 && origin[0] === this.options.origin);
  }
}
