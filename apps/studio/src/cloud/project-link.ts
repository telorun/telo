import type { CloudSessionState } from "./session";

const ORG_PARAM = "org";
const PROJECT_PARAM = "project";
const MODULE_PARAM = "module";
/** Studio's own remote-open parameter; the console never combines it with these. */
const OPEN_PARAM = "open";

const SIGN_IN_TRIED_KEY = "telo-studio:cloud:project-link-sign-in";

/** The console's link to a project: `/?org=<org id>&project=<project id>[&module=<module path>]`. */
export interface ProjectLink {
  orgId: string;
  projectId: string;
  /** The directory of the module's `telo.yaml` in the repository; null for the
   *  module at its root. */
  modulePath: string | null;
}

export type ProjectLinkDecision =
  /** The session is not known yet. */
  | { action: "wait" }
  /** No Cloud behind this origin: the link means nothing here. */
  | { action: "ignore" }
  | { action: "signIn" }
  | { action: "open" }
  | { action: "refuse"; message: string };

/** Reads a project link from a `location.search` string, or null when it holds none. */
export function readProjectLink(search: string): ProjectLink | null {
  const params = new URLSearchParams(search);
  if (params.has(OPEN_PARAM)) return null;
  const orgId = params.get(ORG_PARAM)?.trim() ?? "";
  const projectId = params.get(PROJECT_PARAM)?.trim() ?? "";
  if (!/^org_[0-9a-f]+$/.test(orgId) || !/^prj_[0-9a-f]+$/.test(projectId)) return null;
  const modulePath = (params.get(MODULE_PARAM) ?? "").trim().replace(/^\/+|\/+$/g, "");
  return { orgId, projectId, modulePath: modulePath === "" ? null : modulePath };
}

/**
 * What a project link asks of Studio under the session it finds. A link gets
 * one sign-in: a visitor who comes back from it still outside the named
 * organization is told so, not sent round again.
 */
export function decideProjectLink(
  link: ProjectLink,
  session: CloudSessionState | { status: "loading" },
  signInTried: boolean,
): ProjectLinkDecision {
  switch (session.status) {
    case "loading":
      return { action: "wait" };
    case "unavailable":
      return { action: "ignore" };
    case "unreachable":
      return {
        action: "refuse",
        message: `Telo Cloud could not be reached, so the linked project was not opened: ${session.message}`,
      };
    case "anonymous":
      return signInTried
        ? { action: "refuse", message: "Sign in to Telo Cloud to open the linked project." }
        : { action: "signIn" };
    case "signedIn":
      if (session.identity.org.id === link.orgId) return { action: "open" };
      return signInTried
        ? {
            action: "refuse",
            message:
              "The linked project belongs to another organization than the one you are signed in to. Switch organization to open it.",
          }
        : { action: "signIn" };
  }
}

/** Strips the link's parameters from the address bar so a reload doesn't reopen it. */
export function clearProjectLinkParams(): void {
  const url = new URL(window.location.href);
  for (const param of [ORG_PARAM, PROJECT_PARAM, MODULE_PARAM]) url.searchParams.delete(param);
  window.history.replaceState(window.history.state, "", url.toString());
}

function signInMark(link: ProjectLink): string {
  return `${link.orgId}:${link.projectId}`;
}

/** Recorded before the sign-in navigation, which unloads the page. */
export function noteProjectLinkSignIn(link: ProjectLink): void {
  window.sessionStorage.setItem(SIGN_IN_TRIED_KEY, signInMark(link));
}

export function projectLinkSignInTried(link: ProjectLink): boolean {
  return window.sessionStorage.getItem(SIGN_IN_TRIED_KEY) === signInMark(link);
}

export function forgetProjectLinkSignIn(): void {
  window.sessionStorage.removeItem(SIGN_IN_TRIED_KEY);
}
