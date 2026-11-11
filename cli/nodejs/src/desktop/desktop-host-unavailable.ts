import { RuntimeError } from "@telorun/sdk";

/**
 * `ERR_DESKTOP_HOST_UNAVAILABLE`: `telo run` cannot act as the desktop host.
 * Every cause — no display, an OS too old, a helper that cannot be obtained,
 * started or trusted — is this one error, the reason in its message.
 */
export const DESKTOP_HOST_UNAVAILABLE = "ERR_DESKTOP_HOST_UNAVAILABLE";

export class DesktopHostUnavailable extends RuntimeError {
  constructor(readonly reason: string) {
    super(DESKTOP_HOST_UNAVAILABLE, `cannot start the desktop host: ${reason}`);
    this.name = "DesktopHostUnavailable";
  }
}
