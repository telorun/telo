import type { ViewModel, ViewModelChangedParams } from "@telorun/editor-protocol";
import type { TeloStatus } from "@telorun/language-host";
import { afterEach, expect, it } from "vitest";
import { ViewModelStore, type ViewModelSource, type ViewModelStatus } from "../view-model-store";
import { fakeEngineSpawner } from "./fake-engine";
import { fakeMonaco } from "./fake-monaco";
import { startSession, stopSessions, until } from "./session-harness";

const MODULE = "/ws/app/telo.yaml";
const OWNER = "file:///ws/app/telo.yaml";

const stores: ViewModelStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  await stopSessions();
});

function viewModel(revision: number): ViewModel {
  return {
    owner: OWNER,
    revision,
    moduleGraph: null,
    moduleRootSchema: null,
    kindSpellings: {},
    refConstraints: {},
    contracts: {},
    outputRefusals: [],
    templates: {},
    referenceSites: [],
    documents: { [OWNER]: 1 },
  };
}

/** A store over a session whose bundled engine answers `telo/viewModel` with
 *  `answer`; every status the module takes is recorded in `seen`. */
async function storeServing(answer: () => unknown, viewModelCapability = true) {
  const engine = fakeEngineSpawner(
    { textDocumentSync: 1, ...(viewModelCapability ? { experimental: { telo: { viewModel: true } } } : {}) },
    { "telo/viewModel": answer },
  );
  const session = await startSession({ monaco: fakeMonaco().monaco, spawner: engine.spawner });
  const store = new ViewModelStore(session);
  stores.push(store);
  const seen: ViewModelStatus[] = [];
  store.subscribe(MODULE, () => seen.push(store.get(MODULE)));
  const requests = () => engine.received.filter((m) => m.method === "telo/viewModel");
  return { store, seen, engine, requests };
}

const revisionOf = (status: ViewModelStatus) => (status.state === "ready" ? status.model.revision : undefined);

it("reads a module's view model when first read, and again when its engine announces a newer revision", async () => {
  let revision = 1;
  const { store, engine, requests } = await storeServing(() => viewModel(revision));
  await until(() => revisionOf(store.get(MODULE)) === 1, "the first model");
  expect(requests()[0]!.params).toEqual({ owner: OWNER });

  revision = 2;
  await engine.notify("telo/viewModelChanged", { owner: OWNER, revision: 2 });
  await until(() => revisionOf(store.get(MODULE)) === 2, "the announced model");
  expect(requests()).toHaveLength(2);
});

it("drops an answer older than the model it holds", async () => {
  const answers = [2, 1, 4];
  const { store, seen, engine, requests } = await storeServing(() => viewModel(answers.shift()!));
  await until(() => revisionOf(store.get(MODULE)) === 2, "the first model");

  await engine.notify("telo/viewModelChanged", { owner: OWNER, revision: 3 });
  await until(() => requests().length === 2, "the second read");
  await engine.notify("telo/viewModelChanged", { owner: OWNER, revision: 4 });
  await until(() => revisionOf(store.get(MODULE)) === 4, "the newest model");

  expect(seen.flatMap((s) => (s.state === "ready" ? [s.model.revision] : []))).toEqual([2, 4]);
});

it("reads a module the engine is not analysing as absent", async () => {
  const { store } = await storeServing(() => null);
  await until(() => store.get(MODULE).state === "absent", "the absent model");
});

it("names the version of an engine that predates structured editing, and asks it nothing", async () => {
  const { store, requests } = await storeServing(() => viewModel(1), false);
  expect(store.get(MODULE)).toEqual({ state: "unsupported", version: "0.101.0" });
  expect(requests()).toEqual([]);
});

it("carries the reason a read failed in the module's status", async () => {
  const { store } = await storeServing(() => {
    throw new Error("the analysis crashed");
  });
  await until(() => store.get(MODULE).state === "failed", "the failure");
  const status = store.get(MODULE);
  expect(status.state === "failed" && status.error).toContain("the analysis crashed");
});

it("reads a module whose read failed again when asked to retry", async () => {
  let fail = true;
  const { store } = await storeServing(() => {
    if (fail) throw new Error("the analysis crashed");
    return viewModel(1);
  });
  await until(() => store.get(MODULE).state === "failed", "the failure");

  fail = false;
  store.retry(MODULE);
  await until(() => revisionOf(store.get(MODULE)) === 1, "the model read on retry");
});

/** A source whose every answer the test sets: whether an engine serves the
 *  module, the session's status, each `telo/viewModel` reply (settled by the
 *  test), the editor's document versions and the session's retry. */
function controlledSource() {
  const changed = new Set<(params: ViewModelChangedParams) => void>();
  const statusListeners = new Set<(status: TeloStatus) => void>();
  const pending: Array<{ resolve(model: ViewModel | null): void }> = [];
  const control = {
    supported: undefined as boolean | undefined,
    status: { pinned: false, starting: true } as TeloStatus,
    versions: new Map<string, number>([[OWNER, 1]]),
    retries: 0,
    pending,
    announce: (revision: number) => {
      for (const listener of [...changed]) listener({ owner: OWNER, revision });
    },
    statusMoved: () => {
      for (const listener of [...statusListeners]) listener(control.status);
    },
  };
  const source: ViewModelSource = {
    ownerOf: () => OWNER,
    supportsViewModel: () => control.supported,
    viewModel: () => new Promise((resolve) => pending.push({ resolve })),
    statusOf: () => control.status,
    retry: async () => {
      control.retries += 1;
      control.status = { pinned: false, starting: true };
    },
    documentVersion: (uri) => control.versions.get(uri),
    onViewModelChanged: (listener) => {
      changed.add(listener);
      return { dispose: () => void changed.delete(listener) };
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return { dispose: () => void statusListeners.delete(listener) };
    },
  };
  const store = new ViewModelStore(source);
  stores.push(store);
  store.subscribe(MODULE, () => undefined);
  return { store, control };
}

it("reads a module again when its engine comes to serve it, as the session's status moves", async () => {
  const { store, control } = controlledSource();
  expect(store.get(MODULE)).toEqual({ state: "loading" });
  expect(control.pending).toHaveLength(0);

  control.supported = true;
  control.status = { pinned: false, starting: false, version: "0.104.0" };
  control.statusMoved();
  expect(control.pending).toHaveLength(1);
  control.pending[0]!.resolve(viewModel(1));
  await until(() => revisionOf(store.get(MODULE)) === 1, "the model read once served");
});

it("reads once more after a fetch in flight when a newer revision is announced meanwhile", async () => {
  const { store, control } = controlledSource();
  control.supported = true;
  control.statusMoved();
  control.announce(2);
  expect(control.pending).toHaveLength(1);

  control.pending[0]!.resolve(viewModel(1));
  await until(() => control.pending.length === 2, "the read the announcement asked for");
  control.pending[1]!.resolve(viewModel(2));
  await until(() => revisionOf(store.get(MODULE)) === 2, "the announced model");
});

it("fails, in the session's words, a module whose engine cannot run, and starts it again on retry", async () => {
  const { store, control } = controlledSource();
  control.status = {
    pinned: true,
    starting: false,
    error: { kind: "offline-uncached", version: "0.90.0", message: "telo 0.90.0 is not cached and the registry is unreachable." },
  };
  control.statusMoved();
  expect(store.get(MODULE)).toEqual({
    state: "failed",
    error: "telo 0.90.0 is not cached and the registry is unreachable.",
  });

  store.retry(MODULE);
  await until(() => control.retries === 1, "the session's retry");
  expect(store.get(MODULE)).toEqual({ state: "loading" });
});

it("holds a model current only while every document it was analysed from is at the version it read", () => {
  const { store, control } = controlledSource();
  const model = { ...viewModel(1), documents: { [OWNER]: 1, "file:///ws/app/routes.yaml": 3 } };
  control.versions.set("file:///ws/app/routes.yaml", 3);
  expect(store.isCurrent(model)).toBe(true);
  control.versions.set("file:///ws/app/routes.yaml", 4);
  expect(store.isCurrent(model)).toBe(false);
  expect(store.isCurrent({ ...model, documents: {} })).toBe(false);
});

it("asks for the picked configuration and takes its answer at the revision it holds", async () => {
  let read = 0;
  const { store, requests } = await storeServing(() => ({ ...viewModel(1), kindSpellings: { read: String(++read) } }));
  const spelling = () => {
    const status = store.get(MODULE);
    return status.state === "ready" ? status.model.kindSpellings.read : undefined;
  };
  await until(() => spelling() === "1", "the first model");

  store.configure(MODULE, { "variables.dialect": "memory" });
  await until(() => spelling() === "2", "the model for the picked configuration");
  expect(requests()[1]!.params).toEqual({ owner: OWNER, configuration: { "variables.dialect": "memory" } });
});
