import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  CloudApi,
  CloudApiError,
  type CloudRepository,
  type CloudProject,
  type Publication,
  type ProjectRole,
} from "./api";
import { cloudBackend } from "./backend";
import { repositoryRefusalMessage } from "./refusal-messages";
import type { CloudSessionState } from "./session";
import { readSnapshotTar } from "./snapshot-tar";
import { CommitLimitError, type PathChange, type PreparedUpdate } from "./working-copy";
import { cloudProjectIdOf, cloudWorkspaceRoot } from "./working-copy-adapter";
import {
  findWorkingCopy,
  forgetOrphanedWorkingCopy,
  forgetWorkingCopy,
  loadOrphanedWorkingCopies,
  loadWorkingCopyIndex,
  putWorkingCopy,
  updateWorkingCopy,
  type OrphanedWorkingCopy,
  type WorkingCopyEntry,
} from "./working-copy-index";
import { onWorkingCopyWrite, workingCopyOf } from "./working-copy-store";

/** How often the branch head is read while a Cloud project is open. */
const HEAD_POLL_MS = 30_000;
const PUBLICATION_POLL_MS = 2_000;
const CHANGES_DEBOUNCE_MS = 600;

/** What the editor lends the Cloud layer: it owns the open workspace, so
 *  opening, closing and re-reading one are its to do. */
export interface CloudHost {
  open(rootDir: string): Promise<void>;
  close(rootDir: string): void;
  /** The working tree changed beneath the editor. */
  reload(): Promise<void>;
  /** False while a run sync or an agent turn is in progress. */
  idle(): boolean;
}

export type CloudOperation = "committing" | "updating" | "discarding" | "switching";

/** The Cloud project open in the editor. */
export interface ActiveCloudProject {
  projectId: string;
  name: string;
  role: ProjectRole;
  branch: string;
  baseCommit: string | null;
  /** Null until first computed. */
  changes: PathChange[] | null;
  /** The branch has commits the working copy does not. */
  behind: boolean;
  operation: CloudOperation | null;
  /** An update waiting for the user to settle its conflicts. */
  conflict: PreparedUpdate | null;
  /** The host refused the last commit's push to this branch. */
  pushRejected: boolean;
}

export type CloudActionResult = { ok: true } | { ok: false; message: string };

interface CloudContextValue {
  session: CloudSessionState | { status: "loading" };
  api: CloudApi;
  signIn(): void;
  switchOrganization(): void;
  retrySession(): void;
  /** Sign-out removes the working copies, so it asks first when there are any. */
  requestSignOut(): void;
  signOutPrompt: { total: number; dirty: string[] } | null;
  confirmSignOut(): Promise<void>;
  cancelSignOut(): void;
  /** Working copies of another user found under this session. */
  foreignCopies: WorkingCopyEntry[] | null;
  removeForeignCopies(): Promise<void>;
  declineForeignCopies(): void;
  /** Working copies whose id names no project Cloud still has. */
  orphanedCopies: OrphanedWorkingCopy[] | null;
  removeOrphanedCopies(): Promise<void>;
  /** Leaves them on the device until Studio is next loaded. */
  keepOrphanedCopies(): void;

  registerHost(host: CloudHost | null): void;
  setActiveRoot(rootDir: string | null): void;
  openProject(project: CloudProject): Promise<CloudActionResult>;

  active: ActiveCloudProject | null;
  /** Why the open Cloud project cannot be edited right now, if it cannot. */
  editingLock: "viewer" | "updating" | null;
  /** Bumps when the working tree was rewritten beneath the editor. */
  filesEpoch: number;
  refreshChanges(): void;
  commit(message: string): Promise<CloudActionResult>;
  commitToNewBranch(name: string, message: string): Promise<CloudActionResult>;
  dismissPushRejected(): void;
  update(): Promise<CloudActionResult>;
  resolveConflicts(theirs: ReadonlySet<string>): Promise<CloudActionResult>;
  cancelConflicts(): void;
  discard(): Promise<CloudActionResult>;
  switchBranch(branch: string): Promise<CloudActionResult>;
  publish(
    modulePath: string,
    onProgress: (publication: Publication) => void,
  ): Promise<{ ok: true; publication: Publication } | { ok: false; message: string }>;
}

const CloudContext = createContext<CloudContextValue | null>(null);

export function useCloud(): CloudContextValue {
  const value = useContext(CloudContext);
  if (!value) throw new Error("useCloud must be used inside a CloudProvider.");
  return value;
}

async function sha256Text(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

function activeFrom(entry: WorkingCopyEntry): ActiveCloudProject {
  return {
    projectId: entry.projectId,
    name: entry.projectName,
    role: entry.role,
    branch: entry.branch,
    baseCommit: entry.baseCommit,
    changes: null,
    behind: false,
    operation: null,
    conflict: null,
    pushRejected: false,
  };
}

export function CloudProvider({ children }: { children: ReactNode }) {
  const backend = useMemo(() => cloudBackend(), []);
  const [session, setSession] = useState<CloudContextValue["session"]>({ status: "loading" });
  const [active, setActive] = useState<ActiveCloudProject | null>(null);
  const [filesEpoch, setFilesEpoch] = useState(0);
  const [signOutPrompt, setSignOutPrompt] = useState<CloudContextValue["signOutPrompt"]>(null);
  const [foreignCopies, setForeignCopies] = useState<WorkingCopyEntry[] | null>(null);
  const [orphanedCopies, setOrphanedCopies] = useState<OrphanedWorkingCopy[] | null>(() => {
    const orphaned = loadOrphanedWorkingCopies();
    return orphaned.length > 0 ? orphaned : null;
  });

  const hostRef = useRef<CloudHost | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // One working-copy operation at a time: a scan must not read a tree an
  // update is half-way through rewriting.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const headRef = useRef<{ key: string; etag: string | null; commit: string | null } | null>(null);
  const repositoryRef = useRef<Map<string, CloudRepository>>(new Map());

  const serialized = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(work, work);
    queueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const patchActive = useCallback((projectId: string, patch: Partial<ActiveCloudProject>) => {
    setActive((current) =>
      current && current.projectId === projectId ? { ...current, ...patch } : current,
    );
  }, []);

  const loadSession = useCallback(async () => {
    let next: CloudSessionState;
    try {
      next = await backend.read();
    } catch (err) {
      next = { status: "unreachable", message: err instanceof Error ? err.message : String(err) };
    }
    setSession(next);
    if (next.status === "signedIn") {
      const userId = next.identity.user.id;
      const foreign = loadWorkingCopyIndex().filter((entry) => entry.userId !== userId);
      setForeignCopies(foreign.length > 0 ? foreign : null);
    }
  }, [backend]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const api = useMemo(
    () =>
      new CloudApi(backend, {
        // Back to anonymous without touching the working copy: whatever was
        // being edited stays on the device.
        onSessionLost: () => void loadSession(),
      }),
    [backend, loadSession],
  );

  const authorize = useCallback(
    (start: () => Promise<CloudSessionState>) => {
      start().then(
        () => void loadSession(),
        (err: unknown) => toast.error(err instanceof Error ? err.message : String(err)),
      );
    },
    [loadSession],
  );
  const signIn = useCallback(() => authorize(() => backend.signIn()), [authorize, backend]);
  const switchOrganization = useCallback(
    () => authorize(() => backend.switchOrganization()),
    [authorize, backend],
  );

  // ---------------------------------------------------------------------------
  // Leaving
  // ---------------------------------------------------------------------------

  const removeCopies = useCallback(
    async (entries: WorkingCopyEntry[]) => {
      for (const entry of entries) {
        hostRef.current?.close(cloudWorkspaceRoot(entry.projectId));
        await serialized(() => workingCopyOf(entry.projectId).remove());
        forgetWorkingCopy(entry.projectId);
      }
    },
    [serialized],
  );

  const signOutNow = useCallback(async () => {
    try {
      await backend.signOut();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    await loadSession();
  }, [backend, loadSession]);

  const requestSignOut = useCallback(() => {
    const entries = loadWorkingCopyIndex();
    if (entries.length === 0) {
      void signOutNow();
      return;
    }
    void (async () => {
      const dirty: string[] = [];
      for (const entry of entries) {
        const changes = await serialized(() => workingCopyOf(entry.projectId).changes());
        if (changes.length > 0) dirty.push(entry.projectName);
      }
      setSignOutPrompt({ total: entries.length, dirty });
    })().catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [serialized, signOutNow]);

  const confirmSignOut = useCallback(async () => {
    setSignOutPrompt(null);
    try {
      await removeCopies(loadWorkingCopyIndex());
    } catch (err) {
      toast.error(
        `The working copies could not be removed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await signOutNow();
  }, [removeCopies, signOutNow]);

  const removeForeignCopies = useCallback(async () => {
    const entries = foreignCopies ?? [];
    setForeignCopies(null);
    try {
      await removeCopies(entries);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [foreignCopies, removeCopies]);

  const removeOrphanedCopies = useCallback(async () => {
    const copies = orphanedCopies ?? [];
    setOrphanedCopies(null);
    try {
      for (const copy of copies) {
        hostRef.current?.close(cloudWorkspaceRoot(copy.id));
        await serialized(() => workingCopyOf(copy.id).remove());
        forgetOrphanedWorkingCopy(copy.id);
      }
    } catch (err) {
      toast.error(
        `The working copies could not be removed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [orphanedCopies, serialized]);

  const keepOrphanedCopies = useCallback(() => setOrphanedCopies(null), []);

  const declineForeignCopies = useCallback(() => {
    setForeignCopies(null);
    void signOutNow();
  }, [signOutNow]);

  // ---------------------------------------------------------------------------
  // The open project
  // ---------------------------------------------------------------------------

  const setActiveRoot = useCallback((rootDir: string | null) => {
    const projectId = cloudProjectIdOf(rootDir);
    const entry = projectId ? findWorkingCopy(projectId) : null;
    setActive((current) => {
      if (!entry) return null;
      return current?.projectId === entry.projectId ? current : activeFrom(entry);
    });
  }, []);

  const scanChanges = useCallback(
    async (projectId: string) => {
      const changes = await serialized(() => workingCopyOf(projectId).changes());
      patchActive(projectId, { changes });
      return changes;
    },
    [patchActive, serialized],
  );

  const activeId = active?.projectId ?? null;
  const changesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshChanges = useCallback(() => {
    const projectId = activeRef.current?.projectId;
    if (!projectId) return;
    if (changesTimerRef.current) clearTimeout(changesTimerRef.current);
    changesTimerRef.current = setTimeout(() => {
      scanChanges(projectId).catch((err: unknown) =>
        toast.error(
          `The working copy could not be read: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, CHANGES_DEBOUNCE_MS);
  }, [scanChanges]);

  useEffect(() => {
    if (!activeId) return;
    refreshChanges();
    return onWorkingCopyWrite((projectId) => {
      if (projectId === activeId) refreshChanges();
    });
  }, [activeId, refreshChanges]);

  const repositoryOf = useCallback(
    async (projectId: string) => {
      const known = repositoryRef.current.get(projectId);
      if (known) return known;
      const repository = await api.getRepository(projectId);
      repositoryRef.current.set(projectId, repository);
      return repository;
    },
    [api],
  );

  const snapshotAt = useCallback(
    async (projectId: string, commit: string | null) =>
      commit ? readSnapshotTar(await api.downloadSnapshot(projectId, commit)) : [],
    [api],
  );

  const openProject = useCallback(
    async (project: CloudProject): Promise<CloudActionResult> => {
      const current = sessionRef.current;
      const host = hostRef.current;
      if (current.status !== "signedIn" || !host) {
        return { ok: false, message: "Sign in to Telo Cloud first." };
      }
      try {
        const existing = findWorkingCopy(project.id);
        if (existing && (await workingCopyOf(project.id).exists())) {
          // One working copy per project on a device: reopening reuses it.
          putWorkingCopy({
            ...existing,
            projectName: project.name,
            role: project.effectiveRole,
          });
        } else {
          const repository = await repositoryOf(project.id);
          const head = (await api.getHead(project.id, repository.defaultBranch))!.head;
          const snapshot = await snapshotAt(project.id, head.commit);
          await serialized(() =>
            workingCopyOf(project.id).seed(repository.defaultBranch, head.commit, snapshot),
          );
          putWorkingCopy({
            userId: current.identity.user.id,
            orgId: current.identity.org.id,
            projectId: project.id,
            projectName: project.name,
            role: project.effectiveRole,
            branch: repository.defaultBranch,
            baseCommit: head.commit,
          });
        }
        await host.open(cloudWorkspaceRoot(project.id));
        return { ok: true };
      } catch (err) {
        return { ok: false, message: repositoryRefusalMessage(err) };
      }
    },
    [api, repositoryOf, serialized, snapshotAt],
  );

  // ---------------------------------------------------------------------------
  // Update: bring the working copy onto the branch head
  // ---------------------------------------------------------------------------

  const applyUpdate = useCallback(
    async (projectId: string, prepared: PreparedUpdate, theirs: ReadonlySet<string>) => {
      await serialized(() => workingCopyOf(projectId).applyUpdate(prepared, theirs));
      updateWorkingCopy(projectId, (entry) => ({
        ...entry,
        baseCommit: prepared.headCommit,
        pendingCommit: undefined,
      }));
      patchActive(projectId, {
        baseCommit: prepared.headCommit,
        behind: false,
        conflict: null,
      });
      setFilesEpoch((epoch) => epoch + 1);
      await hostRef.current?.reload();
      await scanChanges(projectId);
    },
    [patchActive, scanChanges, serialized],
  );

  /** Downloads the head and merges it in, stopping at conflicts for the user. */
  const updateTo = useCallback(
    async (projectId: string, headCommit: string | null): Promise<"updated" | "conflicts"> => {
      const snapshot = await snapshotAt(projectId, headCommit);
      const prepared = await serialized(() =>
        workingCopyOf(projectId).prepareUpdate(headCommit, snapshot),
      );
      if (prepared.plan.conflicts.length > 0) {
        patchActive(projectId, { conflict: prepared, behind: true });
        return "conflicts";
      }
      await applyUpdate(projectId, prepared, new Set());
      return "updated";
    },
    [applyUpdate, patchActive, serialized, snapshotAt],
  );

  /** Runs one operation on the open project, marking it busy meanwhile. */
  const operate = useCallback(
    async (
      operation: CloudOperation,
      work: (current: ActiveCloudProject) => Promise<CloudActionResult>,
    ): Promise<CloudActionResult> => {
      const current = activeRef.current;
      if (!current) return { ok: false, message: "No Telo Cloud project is open." };
      if (current.operation || current.conflict) {
        return { ok: false, message: "Another operation on this project is in progress." };
      }
      if (sessionRef.current.status !== "signedIn") {
        return { ok: false, message: "Sign in to Telo Cloud first." };
      }
      patchActive(current.projectId, { operation });
      try {
        return await work(current);
      } catch (err) {
        return {
          ok: false,
          message: err instanceof CommitLimitError ? err.message : repositoryRefusalMessage(err),
        };
      } finally {
        patchActive(current.projectId, { operation: null });
      }
    },
    [patchActive],
  );

  const update = useCallback(
    () =>
      operate("updating", async (current) => {
        if (!hostRef.current?.idle()) {
          return {
            ok: false,
            message: "Wait for the running agent turn or run sync to finish, then update.",
          };
        }
        const head = (await api.getHead(current.projectId, current.branch))!.head;
        if (head.commit === current.baseCommit) {
          patchActive(current.projectId, { behind: false });
          return { ok: true };
        }
        await updateTo(current.projectId, head.commit);
        return { ok: true };
      }),
    [api, operate, patchActive, updateTo],
  );

  const resolveConflicts = useCallback(
    async (theirs: ReadonlySet<string>): Promise<CloudActionResult> => {
      const current = activeRef.current;
      if (!current?.conflict) return { ok: false, message: "There is no conflict to settle." };
      patchActive(current.projectId, { operation: "updating" });
      try {
        await applyUpdate(current.projectId, current.conflict, theirs);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: repositoryRefusalMessage(err) };
      } finally {
        patchActive(current.projectId, { operation: null });
      }
    },
    [applyUpdate, patchActive],
  );

  const cancelConflicts = useCallback(() => {
    const current = activeRef.current;
    if (current) patchActive(current.projectId, { conflict: null });
  }, [patchActive]);

  // The branch head: read when the window gains focus and every 30 seconds.
  // A clean working copy follows it once nothing else is writing; one with
  // local changes is told and offered "Update".
  const signedIn = session.status === "signedIn";
  const activeBranch = active?.branch ?? null;
  useEffect(() => {
    if (!activeId || !activeBranch || !signedIn) return;
    const key = `${activeId}#${activeBranch}`;
    let stopped = false;
    const poll = async () => {
      const current = activeRef.current;
      if (stopped || !current || current.operation || current.conflict) return;
      try {
        const known = headRef.current?.key === key ? headRef.current : null;
        const answer = await api.getHead(activeId, activeBranch, known?.etag ?? undefined);
        if (answer) headRef.current = { key, etag: answer.etag, commit: answer.head.commit };
        const head = headRef.current;
        const now = activeRef.current;
        if (stopped || !head || !now || now.operation || now.conflict) return;
        if (head.commit === now.baseCommit || head.commit === null) {
          if (now.behind) patchActive(activeId, { behind: false });
          return;
        }
        const changes = await scanChanges(activeId);
        if (changes.length === 0 && hostRef.current?.idle()) {
          patchActive(activeId, { operation: "updating" });
          try {
            await updateTo(activeId, head.commit);
          } finally {
            patchActive(activeId, { operation: null });
          }
        } else {
          patchActive(activeId, { behind: true });
        }
      } catch (err) {
        // A poll is not something the user asked for: a refusal here is
        // reported by the action that needs the head, not by a banner every
        // 30 seconds.
        console.warn("Telo Cloud branch head could not be read:", err);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), HEAD_POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeBranch, activeId, api, patchActive, scanChanges, signedIn, updateTo]);

  // The caller's role can change while a working copy sits on the device, and
  // it decides whether the project may be edited: read it again per session.
  useEffect(() => {
    if (!activeId || !signedIn) return;
    let stopped = false;
    api.listProjects().then(
      (projects) => {
        const project = projects.find((w) => w.id === activeId);
        if (stopped || !project) return;
        updateWorkingCopy(activeId, (entry) => ({
          ...entry,
          projectName: project.name,
          role: project.effectiveRole,
        }));
        patchActive(activeId, { name: project.name, role: project.effectiveRole });
      },
      (err: unknown) => console.warn("Telo Cloud projects could not be listed:", err),
    );
    return () => {
      stopped = true;
    };
  }, [activeId, api, patchActive, signedIn]);

  // ---------------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------------

  const commitOn = useCallback(
    async (current: ActiveCloudProject, branch: string, message: string): Promise<CloudActionResult> => {
      const { projectId } = current;
      const copy = workingCopyOf(projectId);
      const baseCommit = await copy.baseCommit();

      // Before every commit: a branch that moved is merged first, so the
      // commit is of a tree the user has seen.
      const head = (await api.getHead(projectId, branch))!.head;
      if (head.commit !== baseCommit && head.commit !== null) {
        const outcome = await updateTo(projectId, head.commit);
        return {
          ok: false,
          message:
            outcome === "conflicts"
              ? "The branch has new commits that conflict with your changes. Settle them, then commit again."
              : "The branch had new commits; they are merged into your working copy. Review and commit again.",
        };
      }

      const repository = await repositoryOf(projectId);
      const prepared = await serialized(() => copy.prepareCommit(repository.limits));
      if (prepared.changes.length === 0) {
        return { ok: false, message: "There is nothing to commit." };
      }
      const request = { branch, baseCommit, message, changes: prepared.changes };
      // A retry of the same commit — after a reload too — reuses its key, so
      // however many attempts reach Cloud, one commit comes of them.
      const fingerprint = await sha256Text(JSON.stringify(request));
      const pending = findWorkingCopy(projectId)?.pendingCommit;
      const key = pending?.fingerprint === fingerprint ? pending.key : crypto.randomUUID();
      updateWorkingCopy(projectId, (entry) => ({ ...entry, pendingCommit: { key, fingerprint } }));

      try {
        const result = await api.commit(projectId, request, key);
        await serialized(() => copy.recordCommit(result.commit, prepared));
        updateWorkingCopy(projectId, (entry) => ({
          ...entry,
          branch,
          baseCommit: result.commit,
          pendingCommit: undefined,
        }));
        patchActive(projectId, {
          branch,
          baseCommit: result.commit,
          behind: false,
          pushRejected: false,
        });
        await scanChanges(projectId);
        return { ok: true };
      } catch (err) {
        if (!(err instanceof CloudApiError)) throw err;
        // A refusal is an answer: the same key must not be sent again for it.
        if (err.status < 500) {
          updateWorkingCopy(projectId, (entry) => ({ ...entry, pendingCommit: undefined }));
        }
        if (err.code === "branch_moved") {
          const headCommit =
            typeof err.problem.headCommit === "string" ? err.problem.headCommit : null;
          const outcome = await updateTo(projectId, headCommit);
          return {
            ok: false,
            message:
              outcome === "conflicts"
                ? "The branch moved while you were committing. Settle the conflicts, then commit again."
                : "The branch moved while you were committing; its commits are merged into your working copy. Commit again.",
          };
        }
        if (err.code === "push_rejected") {
          patchActive(projectId, { pushRejected: true });
          return {
            ok: false,
            message: `The git host refused the push to ${branch} — the branch is protected. Commit to a new branch instead.`,
          };
        }
        throw err;
      }
    },
    [api, patchActive, repositoryOf, scanChanges, serialized, updateTo],
  );

  const commit = useCallback(
    (message: string) =>
      operate("committing", (current) => commitOn(current, current.branch, message)),
    [commitOn, operate],
  );

  const commitToNewBranch = useCallback(
    (name: string, message: string) =>
      operate("committing", async (current) => {
        if (current.baseCommit === null) {
          return { ok: false, message: "There is no commit to create the branch from." };
        }
        await api.createBranch(current.projectId, name, current.baseCommit);
        await serialized(() => workingCopyOf(current.projectId).setBranch(name));
        updateWorkingCopy(current.projectId, (entry) => ({ ...entry, branch: name }));
        patchActive(current.projectId, { branch: name, pushRejected: false });
        return commitOn(current, name, message);
      }),
    [api, commitOn, operate, patchActive, serialized],
  );

  const dismissPushRejected = useCallback(() => {
    const current = activeRef.current;
    if (current) patchActive(current.projectId, { pushRejected: false });
  }, [patchActive]);

  const discard = useCallback(
    () =>
      operate("discarding", async (current) => {
        await serialized(() => workingCopyOf(current.projectId).discard());
        setFilesEpoch((epoch) => epoch + 1);
        await hostRef.current?.reload();
        await scanChanges(current.projectId);
        return { ok: true };
      }),
    [operate, scanChanges, serialized],
  );

  const switchBranch = useCallback(
    (branch: string) =>
      operate("switching", async (current) => {
        const changes = await scanChanges(current.projectId);
        if (changes.length > 0) {
          return {
            ok: false,
            message: "Commit or discard your changes before switching branches.",
          };
        }
        const head = (await api.getHead(current.projectId, branch))!.head;
        const snapshot = await snapshotAt(current.projectId, head.commit);
        await serialized(() =>
          workingCopyOf(current.projectId).seed(branch, head.commit, snapshot),
        );
        updateWorkingCopy(current.projectId, (entry) => ({
          ...entry,
          branch,
          baseCommit: head.commit,
          pendingCommit: undefined,
        }));
        patchActive(current.projectId, { branch, baseCommit: head.commit, behind: false });
        setFilesEpoch((epoch) => epoch + 1);
        await hostRef.current?.reload();
        await scanChanges(current.projectId);
        return { ok: true };
      }),
    [api, operate, patchActive, scanChanges, serialized, snapshotAt],
  );

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  const publish = useCallback<CloudContextValue["publish"]>(
    async (modulePath, onProgress) => {
      const current = activeRef.current;
      if (!current || current.baseCommit === null) {
        return { ok: false, message: "Commit the module before publishing it." };
      }
      try {
        let publication = await api.createPublication(
          current.projectId,
          { modulePath, commit: current.baseCommit },
          crypto.randomUUID(),
        );
        onProgress(publication);
        while (publication.status === "queued" || publication.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, PUBLICATION_POLL_MS));
          publication = await api.getPublication(current.projectId, publication.id);
          onProgress(publication);
        }
        return { ok: true, publication };
      } catch (err) {
        return { ok: false, message: repositoryRefusalMessage(err) };
      }
    },
    [api],
  );

  const registerHost = useCallback((host: CloudHost | null) => {
    hostRef.current = host;
  }, []);

  const editingLock: CloudContextValue["editingLock"] = !active
    ? null
    : active.role === "viewer"
      ? "viewer"
      : active.conflict || active.operation === "updating" || active.operation === "switching" || active.operation === "discarding"
        ? "updating"
        : null;

  const value: CloudContextValue = {
    session,
    api,
    signIn,
    switchOrganization,
    retrySession: () => void loadSession(),
    requestSignOut,
    signOutPrompt,
    confirmSignOut,
    cancelSignOut: () => setSignOutPrompt(null),
    foreignCopies,
    removeForeignCopies,
    declineForeignCopies,
    orphanedCopies,
    removeOrphanedCopies,
    keepOrphanedCopies,
    registerHost,
    setActiveRoot,
    openProject,
    active,
    editingLock,
    filesEpoch,
    refreshChanges,
    commit,
    commitToNewBranch,
    dismissPushRejected,
    update,
    resolveConflicts,
    cancelConflicts,
    discard,
    switchBranch,
    publish,
  };

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}
