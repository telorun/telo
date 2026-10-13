import * as React from "react";
import { useLocation, useNavigate } from "react-router";

import type { Route } from "./+types/auth-callback";
import { Button } from "@/components/ui/button";
import { useSession } from "@/session";

export const meta: Route.MetaFunction = () => [
  { title: "Signing in — Telo Hub" },
  { name: "robots", content: "noindex" },
];

/** The address holds a one-time authorization code: never stored, never sent on
 *  as a referrer. */
export function headers(): HeadersInit {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
}

/** Where the provider returns the reader after a sign-in: redeems the code,
 *  then goes back to the page the sign-in was started from. */
export default function AuthCallback() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const { completeSignIn, signIn } = useSession();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    completeSignIn(search).then(
      (returnTo) => {
        if (current) navigate(returnTo, { replace: true });
      },
      (cause: unknown) => {
        console.error(cause);
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [completeSignIn, navigate, search]);

  const retry = () => {
    signIn().catch((cause: unknown) => {
      console.error(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-start gap-4 py-16">
      {error ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Sign-in failed</h1>
          <p role="alert" className="text-muted-foreground">
            {error}
          </p>
          <Button onClick={retry}>Try again</Button>
        </>
      ) : (
        <p role="status" className="text-muted-foreground">
          Signing in…
        </p>
      )}
    </div>
  );
}
