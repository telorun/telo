import {
  beginAuthorization,
  redeemAuthorization,
  SignInError,
  SILENT_PATH,
  type OidcClient,
  type SessionIdentity,
} from "@/oidc-authorization";

/** What the `/auth/silent` page posts to the page that framed it. */
export const SILENT_MESSAGE_TYPE = "hub.auth.silent";

const SILENT_TIMEOUT_MS = 10_000;

/** The provider's ways of saying "nobody is signed in, and I may not ask". */
const NO_SESSION = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
]);

/**
 * Asks the provider, in a hidden frame and without any prompt, who is signed
 * in. Null means nobody. A frame that never answers — the provider is down, or
 * refuses to be framed by this site — is a `SignInError`.
 */
export async function silentAuthorization(
  client: OidcClient,
  signal: AbortSignal,
): Promise<SessionIdentity | null> {
  const { url, pending } = await beginAuthorization(client, SILENT_PATH, "none");
  signal.throwIfAborted();
  const search = await framedResponse(url, signal);
  try {
    return await redeemAuthorization(client, pending, search);
  } catch (error) {
    if (error instanceof SignInError && error.code && NO_SESSION.has(error.code)) return null;
    throw error;
  }
}

function framedResponse(url: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;

    const settle = (outcome: () => void) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
      frame.remove();
      outcome();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; search?: unknown } | null;
      if (data?.type !== SILENT_MESSAGE_TYPE || typeof data.search !== "string") return;
      const { search } = data;
      settle(() => resolve(search));
    };
    const onAbort = () => settle(() => reject(signal.reason));
    const timer = window.setTimeout(
      () =>
        settle(() =>
          reject(new SignInError("The identity provider did not answer the silent sign-in check.")),
        ),
      SILENT_TIMEOUT_MS,
    );

    window.addEventListener("message", onMessage);
    signal.addEventListener("abort", onAbort);
    frame.src = url;
    document.body.append(frame);
  });
}
