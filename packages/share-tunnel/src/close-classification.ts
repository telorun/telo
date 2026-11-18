import { TunnelCloseCode } from "./tunnel-protocol.js";

/** Why the client warns while it keeps retrying. */
export type ShareTunnelWarningReason =
  /** The relay closed `4401`: the presented credential was refused or expired. */
  | "credential-refused"
  /** The credential provider needs the user to sign in again. */
  | "sign-in-required"
  /** The credential provider could not answer this time. */
  | "credential-unavailable"
  /** The relay closed `4429`: the owner is at its connected-share limit. */
  | "owner-limit"
  /** The relay closed `4503`: the runner is at its connected-share capacity. */
  | "runner-capacity"
  /** `4408`: one side received nothing in time. */
  | "timed-out"
  /** The tunnel endpoint could not be reached, or answered without upgrading. */
  | "unreachable"
  /** Any other close. */
  | "disconnected";

/** Why a share is lost for this run. */
export type ShareLostReason =
  /** `4404`: the share was deleted, or is not (or no longer) the caller's. */
  | "deleted"
  /** `4409`: another run took the share over. */
  | "superseded";

export type TunnelCloseClass =
  | { outcome: "lost"; reason: ShareLostReason }
  | { outcome: "runner-unsupported" }
  | { outcome: "retry"; warning: ShareTunnelWarningReason };

/** What the client does when the relay closes the tunnel with `code`. */
export function classifyTunnelClose(code: number): TunnelCloseClass {
  switch (code) {
    case TunnelCloseCode.protocolError:
      return { outcome: "runner-unsupported" };
    case TunnelCloseCode.credentialRefused:
      return { outcome: "retry", warning: "credential-refused" };
    case TunnelCloseCode.shareGone:
      return { outcome: "lost", reason: "deleted" };
    case TunnelCloseCode.timedOut:
      return { outcome: "retry", warning: "timed-out" };
    case TunnelCloseCode.superseded:
      return { outcome: "lost", reason: "superseded" };
    case TunnelCloseCode.ownerLimit:
      return { outcome: "retry", warning: "owner-limit" };
    case TunnelCloseCode.runnerCapacity:
      return { outcome: "retry", warning: "runner-capacity" };
    default:
      return { outcome: "retry", warning: "disconnected" };
  }
}
