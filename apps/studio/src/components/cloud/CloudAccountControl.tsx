import { Cloud, CloudOff, LogIn } from "lucide-react";
import { useCloud } from "../../cloud/context";
import { displayName } from "../../cloud/session";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** The top bar's Telo Cloud entry: nothing where Cloud is not available, a
 *  sign-in button for an anonymous user, the account menu for a signed-in one. */
export function CloudAccountControl() {
  const cloud = useCloud();
  const { session } = cloud;

  if (session.status === "loading" || session.status === "unavailable") return null;

  return (
    <>
      {session.status === "unreachable" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={cloud.retrySession}
          title={`Telo Cloud could not be reached: ${session.message}. Click to retry.`}
        >
          <CloudOff />
          Cloud unreachable
        </Button>
      )}
      {session.status === "anonymous" && (
        <Button variant="ghost" size="sm" onClick={cloud.signIn}>
          <LogIn />
          Sign in
        </Button>
      )}
      {session.status === "signedIn" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title={`Telo Cloud account: ${displayName(session.identity)}`}
              aria-label="Telo Cloud account"
            >
              <Cloud />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate">{displayName(session.identity)}</span>
              {session.identity.user.email && session.identity.user.name && (
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {session.identity.user.email}
                </span>
              )}
              <span className="truncate font-mono text-[10px] font-normal text-muted-foreground">
                {session.identity.org.id}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={cloud.switchOrganization}>
              Switch organization
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={cloud.requestSignOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AlertDialog
        open={cloud.signOutPrompt !== null}
        onOpenChange={(open) => !open && cloud.cancelSignOut()}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of Telo Cloud?</AlertDialogTitle>
            <AlertDialogDescription>
              Signing out removes the {cloud.signOutPrompt?.total ?? 0} Telo Cloud working{" "}
              {cloud.signOutPrompt?.total === 1 ? "copy" : "copies"} from this device.
              {cloud.signOutPrompt && cloud.signOutPrompt.dirty.length > 0
                ? " These projects have changes that were never committed and will be lost:"
                : " Everything in them is committed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cloud.signOutPrompt && cloud.signOutPrompt.dirty.length > 0 && (
            <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm">
              {cloud.signOutPrompt.dirty.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={cloud.signOutPrompt?.dirty.length ? "destructive" : "default"}
              onClick={() => void cloud.confirmSignOut()}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cloud.foreignCopies !== null}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Working copies of another user</AlertDialogTitle>
            <AlertDialogDescription>
              This device holds Telo Cloud working copies that belong to a different user.
              Continuing as {session.status === "signedIn" ? displayName(session.identity) : "this user"}{" "}
              removes them, with any changes that were never committed. Otherwise you are signed
              out again and they stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm">
            {(cloud.foreignCopies ?? []).map((entry) => (
              <li key={entry.projectId} className="truncate">
                {entry.projectName}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cloud.declineForeignCopies}>Sign out</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void cloud.removeForeignCopies()}>
              Remove and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cloud.orphanedCopies !== null}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Working copies without a project</AlertDialogTitle>
            <AlertDialogDescription>
              This device holds Telo Cloud working copies that no longer match a project in Telo
              Cloud, so they cannot be updated, committed or published. Removing them also removes
              any changes that were never committed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm">
            {(cloud.orphanedCopies ?? []).map((copy) => (
              <li key={copy.id} className="truncate">
                {copy.name}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cloud.keepOrphanedCopies}>Not now</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void cloud.removeOrphanedCopies()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
