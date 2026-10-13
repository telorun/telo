import * as React from "react";

import {
  beginAuthorization,
  CALLBACK_PATH,
  endSessionUrl,
  redeemAuthorization,
  SignInError,
  type OidcClient,
  type PendingAuthorization,
  type SessionIdentity,
  type SessionUser,
} from "@/oidc-authorization";
import { silentAuthorization } from "@/silent-authorization";

/** `unavailable` is a site with no identity provider configured, and the state
 *  the server renders: page HTML is shared by every reader, so who is signed in
 *  is only ever known in the browser. */
export type Session =
  | { status: "unavailable" }
  | { status: "resolving" }
  | { status: "anonymous" }
  | { status: "signedIn"; user: SessionUser };

interface SessionContextValue {
  session: Session;
  /** Leaves for the identity provider; the reader returns to this page. */
  signIn(): Promise<void>;
  signOut(): void;
  /** Finishes the sign-in whose redirect carried `search`, and resolves with the
   *  path the reader started it from. */
  completeSignIn(search: string): Promise<string>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error("useSession outside the root layout's SessionProvider");
  return value;
}

/** The one sign-in under way in this tab, kept across the redirect. */
const PENDING_KEY = "hub.auth.pending";

interface StoredAuthorization {
  pending: PendingAuthorization;
  returnTo: string;
}

/** Set while this browser has signed in here and not out. Without it a page
 *  load asks the provider nothing, so an anonymous visit costs no request. */
const SIGNED_IN_KEY = "hub.auth.signedIn";

/** The provider is asked again this long before the answer it gave runs out. */
const RENEWAL_MARGIN_MS = 30_000;
const MIN_RENEWAL_DELAY_MS = 10_000;

/** A path on this site, never another origin's address. */
function localPath(path: unknown): string {
  return typeof path === "string" && /^\/(?![/\\])/.test(path) ? path : "/";
}

export function SessionProvider({
  client,
  children,
}: {
  client: OidcClient | null;
  children: React.ReactNode;
}) {
  const [session, setSession] = React.useState<Session>({ status: "unavailable" });
  const [identity, setIdentity] = React.useState<SessionIdentity | null>(null);
  const completion = React.useRef<{ search: string; result: Promise<string> } | null>(null);

  const hold = React.useCallback((next: SessionIdentity | null) => {
    if (next) window.localStorage.setItem(SIGNED_IN_KEY, "1");
    else window.localStorage.removeItem(SIGNED_IN_KEY);
    setIdentity(next);
    setSession(next ? { status: "signedIn", user: next.user } : { status: "anonymous" });
  }, []);

  // On load, ask the provider who is signed in — for a reader who signed in
  // here before. The callback page is the one place that does not ask: it is
  // finishing a sign-in of its own.
  React.useEffect(() => {
    if (!client || window.location.pathname === CALLBACK_PATH) return;
    if (!window.localStorage.getItem(SIGNED_IN_KEY)) {
      setSession({ status: "anonymous" });
      return;
    }
    const controller = new AbortController();
    setSession({ status: "resolving" });
    silentAuthorization(client, controller.signal).then(hold, (error: unknown) => {
      if (controller.signal.aborted) return;
      // The provider did not answer: nobody is shown, and the next load asks again.
      console.error(error);
      setIdentity(null);
      setSession({ status: "anonymous" });
    });
    return () => controller.abort();
  }, [client, hold]);

  // The answer runs out with the token it came with: ask again shortly before,
  // once the page is in view, so a sign-out elsewhere shows here too.
  React.useEffect(() => {
    if (!client || !identity) return;
    const controller = new AbortController();
    const renew = () => {
      if (document.hidden) {
        document.addEventListener("visibilitychange", renew, { once: true, signal: controller.signal });
        return;
      }
      silentAuthorization(client, controller.signal).then(hold, (error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(error);
        setIdentity(null);
        setSession({ status: "anonymous" });
      });
    };
    const delay = Math.max(identity.expiresAt - Date.now() - RENEWAL_MARGIN_MS, MIN_RENEWAL_DELAY_MS);
    const timer = window.setTimeout(renew, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, identity, hold]);

  const signIn = React.useCallback(async () => {
    if (!client) throw new SignInError("This site has no identity provider configured.");
    const { pathname, search, hash } = window.location;
    const { url, pending } = await beginAuthorization(client, CALLBACK_PATH);
    const stored: StoredAuthorization = {
      pending,
      returnTo: pathname === CALLBACK_PATH ? "/" : pathname + search + hash,
    };
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(stored));
    window.location.assign(url);
  }, [client]);

  const signOut = React.useCallback(() => {
    if (!client || !identity) return;
    window.localStorage.removeItem(SIGNED_IN_KEY);
    window.location.assign(endSessionUrl(client, identity.idToken));
  }, [client, identity]);

  const completeSignIn = React.useCallback(
    (search: string) => {
      // One redirect is redeemed once, however often the page asks.
      if (completion.current?.search === search) return completion.current.result;
      const result = (async () => {
        if (!client) throw new SignInError("This site has no identity provider configured.");
        const raw = window.sessionStorage.getItem(PENDING_KEY);
        window.sessionStorage.removeItem(PENDING_KEY);
        if (!raw) throw new SignInError("No sign-in was started in this tab.");
        const stored = JSON.parse(raw) as StoredAuthorization;
        hold(await redeemAuthorization(client, stored.pending, search));
        return localPath(stored.returnTo);
      })();
      completion.current = { search, result };
      return result;
    },
    [client, hold],
  );

  const value = React.useMemo<SessionContextValue>(
    () => ({ session, signIn, signOut, completeSignIn }),
    [session, signIn, signOut, completeSignIn],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
