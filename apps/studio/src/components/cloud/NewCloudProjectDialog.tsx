import { useEffect, useState, type FormEvent } from "react";
import type { CloudProject, ProjectPlacementOption, RegistryNamespace } from "../../cloud/api";
import { useCloud } from "../../cloud/context";
import {
  CREATE_PROJECTS,
  initialPlacement,
  MANAGE_REGISTRY,
  namespaceProblem,
  placementKey,
  placementLabel,
  placementRef,
  projectRefusalMessage,
  SLUG_MAX,
  slugFrom,
  slugProblem,
} from "../../cloud/new-project";
import { hasPermission } from "../../cloud/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface NewCloudProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is done with the created project in place of opening it. */
  onCreated?: (project: CloudProject) => void;
}

/** What the form needs of Telo Cloud before it can be filled in. */
interface Setup {
  namespace: RegistryNamespace | null;
  /** The name the claim form starts from. */
  suggestion: string | null;
  placements: ProjectPlacementOption[];
}

/**
 * "New Telo Cloud project": a name, a slug and where the project runs. Telo
 * Cloud gives every new project its first stage, Production, on the place
 * chosen here; with nowhere to run, the project is created without one. An
 * organization's first project needs its registry namespace, claimed here
 * first by those who may. The created project is opened at once, unless the
 * caller has something else to do with it.
 */
export function NewCloudProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: NewCloudProjectDialogProps) {
  const cloud = useCloud();
  const { api, session } = cloud;
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  // The slug follows the name until it is edited by hand.
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const [placement, setPlacement] = useState<string | null>(null);
  const [namespaceName, setNamespaceName] = useState("");

  const mayCreate = hasPermission(session, CREATE_PROJECTS);
  const mayClaim = hasPermission(session, MANAGE_REGISTRY);
  const consoleUrl = session.status === "signedIn" ? session.identity.consoleUrl : null;

  useEffect(() => {
    if (!open || !mayCreate) return;
    let stopped = false;
    setSetup(null);
    setError(null);
    setBusy(false);
    setName("");
    setTypedSlug(null);
    (async () => {
      const [namespace, placements] = await Promise.all([
        api.getRegistryNamespace(),
        api.listProjectPlacements(),
      ]);
      const suggestion = namespace === null && mayClaim ? await api.suggestRegistryNamespace() : null;
      return { namespace, suggestion, placements };
    })().then(
      (loaded) => {
        if (stopped) return;
        setSetup(loaded);
        setPlacement(initialPlacement(loaded.placements));
        setNamespaceName(loaded.suggestion ?? "");
      },
      (err: unknown) => {
        if (!stopped) setError(projectRefusalMessage(err));
      },
    );
    return () => {
      stopped = true;
    };
  }, [api, mayClaim, mayCreate, open]);

  const slug = typedSlug ?? slugFrom(name);
  const trimmedName = name.trim();
  const chosen = setup?.placements.find((option) => placementKey(option.placement) === placement);
  const needsChoice = setup !== null && setup.placements.length > 1 && !chosen;
  const canCreate =
    !busy && trimmedName !== "" && slugProblem(slug) === null && !needsChoice;

  async function claim(event: FormEvent) {
    event.preventDefault();
    if (!setup || busy) return;
    const problem = namespaceProblem(namespaceName);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const namespace = await api.claimRegistryNamespace(namespaceName);
      setSetup({ ...setup, namespace });
    } catch (err) {
      setError(projectRefusalMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!setup || !canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: trimmedName,
        slug,
        ...(chosen ? { placement: placementRef(chosen.placement) } : {}),
      });
      if (onCreated) {
        onOpenChange(false);
        onCreated(project);
        return;
      }
      const opened = await cloud.openProject(project);
      if (opened.ok) onOpenChange(false);
      // Created all the same: it is in "Open from Telo Cloud" from now on.
      else setError(`${project.name} was created, but could not be opened: ${opened.message}`);
    } catch (err) {
      setError(projectRefusalMessage(err));
      // What the form offered may be what was refused: read it again.
      api.listProjectPlacements().then(
        (placements) => setSetup((current) => (current ? { ...current, placements } : current)),
        () => undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Telo Cloud project</DialogTitle>
          <DialogDescription>
            A project holds one git repository, its published modules and the applications that run
            from them. It is created in your organization and opened here.
          </DialogDescription>
        </DialogHeader>

        {!mayCreate ? (
          <p className="text-sm text-muted-foreground">
            Your sign-in does not allow creating projects. Organization owners and admins can; if
            you are one, sign out and in again so Studio is granted it.
          </p>
        ) : !setup ? (
          error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )
        ) : setup.namespace === null ? (
          mayClaim ? (
            <form autoComplete="off" className="space-y-3" onSubmit={(event) => void claim(event)}>
              <p className="text-sm">
                Before its first project, your organization claims its name on Telo Cloud's
                registry. Every module it publishes is named by it. It is permanent: it cannot be
                changed or released afterwards.
              </p>
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Registry namespace</span>
                <Input
                  autoFocus
                  autoComplete="off"
                  value={namespaceName}
                  maxLength={40}
                  disabled={busy}
                  onChange={(event) => setNamespaceName(event.target.value)}
                />
              </label>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || namespaceName === ""}>
                  {busy ? "Claiming…" : "Claim namespace"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your organization has not claimed its registry namespace yet, which its first project
              needs. An owner or admin claims it, here or in the Telo Cloud console.
            </p>
          )
        ) : (
          <form autoComplete="off" className="space-y-3" onSubmit={(event) => void create(event)}>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Name</span>
              <Input
                autoFocus
                autoComplete="off"
                value={name}
                maxLength={100}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Slug</span>
              <Input
                autoComplete="off"
                aria-describedby="new-cloud-project-slug-hint"
                value={slug}
                maxLength={SLUG_MAX}
                disabled={busy}
                onChange={(event) => setTypedSlug(event.target.value)}
              />
            </label>
            <p id="new-cloud-project-slug-hint" className="-mt-2 text-xs text-muted-foreground">
              {typedSlug === null
                ? "Lowercase letters, digits and hyphens. It follows the name until you edit it."
                : (slugProblem(slug) ?? "Lowercase letters, digits and hyphens.")}
            </p>

            {setup.placements.length === 0 ? (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                Your organization has nowhere to run a project yet, so this one is created without
                a stage and cannot be deployed until it has one. Hosting is set up in the{" "}
                {consoleUrl ? (
                  <a className="underline" href={consoleUrl} target="_blank" rel="noreferrer">
                    Telo Cloud console
                  </a>
                ) : (
                  "Telo Cloud console"
                )}
                : subscribe to a hosting tier or add a target, then add a stage to the project.
              </p>
            ) : (
              <div className="space-y-1 text-sm">
                <span className="font-medium">Hosting</span>
                <Select
                  value={placement ?? ""}
                  onValueChange={setPlacement}
                  disabled={busy || setup.placements.length === 1}
                >
                  <SelectTrigger className="w-full" aria-label="Hosting">
                    <SelectValue placeholder="Choose where the project runs" />
                  </SelectTrigger>
                  <SelectContent>
                    {setup.placements.map((option) => (
                      <SelectItem
                        key={placementKey(option.placement)}
                        value={placementKey(option.placement)}
                      >
                        {placementLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="block text-xs text-muted-foreground">
                  The project starts with one stage, Production, running there. More stages are
                  added in the Telo Cloud console.
                </span>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canCreate}>
                {busy ? "Creating…" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
