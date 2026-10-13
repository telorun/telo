import * as React from "react";
import { CircleUser, LogIn, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSession } from "@/session";

/** Who is signed in, or the way to sign in. Renders nothing until the browser
 *  knows which, and nothing at all on a site with no identity provider. */
export function SessionControl({ className }: { className: string }) {
  const { session, signIn, signOut } = useSession();
  const [error, setError] = React.useState<string | null>(null);

  if (session.status === "anonymous") {
    return (
      <button
        type="button"
        aria-label="Sign in"
        title={error ?? undefined}
        className={className}
        onClick={() => {
          signIn().catch((cause: unknown) => {
            console.error(cause);
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
      >
        <LogIn />
        <span className="hidden md:inline">Sign in</span>
      </button>
    );
  }
  if (session.status !== "signedIn") return null;

  const { user } = session;
  const label = user.name ?? user.email ?? "Account";
  return (
    <Popover>
      <PopoverTrigger aria-label={`Account: ${label}`} className={className}>
        <CircleUser />
        <span className="hidden max-w-40 truncate md:inline">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>
          <PopoverTitle className="truncate">{label}</PopoverTitle>
          {user.email && user.email !== label && (
            <PopoverDescription className="truncate">{user.email}</PopoverDescription>
          )}
        </PopoverHeader>
        <Button variant="outline" size="sm" onClick={signOut}>
          <LogOut />
          Sign out
        </Button>
      </PopoverContent>
    </Popover>
  );
}
