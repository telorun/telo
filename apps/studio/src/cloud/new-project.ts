import { CloudApiError, type PlacementRef, type ProjectPlacementOption } from "./api";
import { repositoryRefusalMessage } from "./refusal-messages";

/** What Telo Cloud lets a session do, as the session's `permissions` name it. */
export const CREATE_PROJECTS = "cloud:projects.create";
export const MANAGE_REGISTRY = "cloud:registry.manage";

/** Slugs of Telo Cloud's project tree: at most this many characters. */
export const SLUG_MAX = 63;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A registry namespace: 3 to 40 lowercase letters, digits and single hyphens. */
const NAMESPACE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/;

/**
 * The slug a name gives, as Telo Cloud derives it when none is sent: accents
 * dropped, lowercased, runs of anything but letters and digits become one
 * hyphen, trimmed to 63 characters. Empty when the name has no letter or digit.
 */
export function slugFrom(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

export function slugProblem(slug: string): string | null {
  if (slug === "") return "Enter a slug.";
  return SLUG.test(slug)
    ? null
    : "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.";
}

export function namespaceProblem(name: string): string | null {
  return NAMESPACE.test(name)
    ? null
    : "Use 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.";
}

/** A placement as a list's key and a select's value. */
export function placementKey(placement: PlacementRef): string {
  return placement.kind === "target"
    ? `target:${placement.targetId}`
    : `subscription:${placement.subscriptionId}`;
}

/** The placement as a request names it: a listed one carries more than that. */
export function placementRef(placement: PlacementRef): PlacementRef {
  return placement.kind === "target"
    ? { kind: "target", targetId: placement.targetId }
    : { kind: "subscription", subscriptionId: placement.subscriptionId };
}

/**
 * The place a new project's form starts on: the organization's default; with
 * none, the only place there is; with several and no default, none — the user
 * names one. This is the choice Telo Cloud makes for a request that names no
 * placement, shown before the request is sent.
 */
export function initialPlacement(options: readonly ProjectPlacementOption[]): string | null {
  const preferred = options.find((option) => option.isDefault) ?? options[0];
  if (!preferred) return null;
  return preferred.isDefault || options.length === 1 ? placementKey(preferred.placement) : null;
}

export function placementLabel(option: ProjectPlacementOption): string {
  const name = option.provider ? `${option.name} by ${option.provider.name}` : option.name;
  return option.isDefault ? `${name} (organization default)` : name;
}

/** What a refused project creation or namespace claim tells the user. */
export function projectRefusalMessage(err: unknown): string {
  if (!(err instanceof CloudApiError)) return repositoryRefusalMessage(err);
  switch (err.code) {
    case "slug_unavailable":
      return "Another project of this organization already has that slug. Choose another.";
    case "registry_name_unavailable":
      return "That slug was the registry name of a project of this organization before, and a registry name is never given out twice. Choose another slug.";
    case "registry_namespace_required":
      return "The organization has no registry namespace yet. Claim one first.";
    case "registry_namespace_unavailable":
      return "That namespace is not available. Choose another.";
    case "registry_namespace_already_claimed":
      return "The organization already has its registry namespace.";
    case "placement_required":
      return "The organization has several places a project can run on and no default. Choose where this project runs.";
    case "placement_not_usable":
    case "target_attached_to_tier":
      return "A new project cannot run there any more. Choose another place.";
    case "subscription_ended":
      return "That subscription has ended. Choose another place.";
    case "tier_limit_exceeded":
      return err.message;
    case "rate_limited":
      return "Too many attempts. Try again later.";
    case "insufficient_permission":
      return "Your role in this organization does not allow that. Ask an owner or admin.";
    default:
      return repositoryRefusalMessage(err);
  }
}
