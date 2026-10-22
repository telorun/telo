import {
  parts,
  prepareWindow,
  runScene,
  runVector,
  scenes,
  tokenProperty,
  vectors,
  type ElementSpec,
  type Problem as StepProblem,
  type SceneHost,
  type VectorHost,
} from "@telorun/ui-react-contract";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openWindow, windowConsole } from "./conformance-window.js";
import { loadSets, type CheckedSet, type LoadedSet } from "./control-sets.js";
import type { Problem } from "./problem.js";
import { StyleCoverage, type ReadStylesheet, type UnstyledPart } from "./style-coverage.js";
import { readStylesheet } from "./stylesheet-rules.js";
import { tokenProblems } from "./token-coverage.js";
import { stageWindow, type WindowEntries } from "./window-staging.js";

/**
 * The window's side of a check: this module's own bundle, started again in a
 * worker with {@link CONFORMANCE_WORKER} in its worker data. Nothing here may
 * evaluate `@telorun/sdk` — a worker has no kernel for it to resolve against —
 * so the bundle imports only its types at the top level.
 */
export const CONFORMANCE_WORKER = "telo.ui-react-conformance.window";

/** A theme's look, for the style half. */
export interface CheckedLook {
  /** Absolute paths of the theme's own stylesheets, in order. */
  stylesheets: string[];
  unstyled: UnstyledPart[];
  /** The design token names, and those the theme's own token set gives a value. */
  tokens: { names: string[]; given: string[] };
}

export interface WindowJob {
  readonly [CONFORMANCE_WORKER]: true;
  entries: Omit<WindowEntries, "sets">;
  sets: CheckedSet[];
  /** Present for a theme: its scenes are drawn and its stylesheets judged. */
  look?: CheckedLook;
}

export type WindowReply = { type: "done"; problems: Problem[] } | { type: "failed"; message: string };

/** A line the window wrote, sent ahead of the reply. */
export interface WindowOutput {
  type: "output";
  line: string;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const stepsOf = (problems: StepProblem[]) =>
  problems.map((problem) => (problem.step === null ? problem.message : `step ${problem.step + 1}: ${problem.message}`)).join("; ");

/** What the window's React is asked for: the staged `react` and `react-dom/client` entries. */
interface React {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  Fragment: unknown;
}
interface ReactDomClient {
  createRoot(container: HTMLElement): { render(element: unknown): void; unmount(): void };
}

/** Draws a control with the window's React into the interpreter's container, as the renderer would. */
function reactHost(react: React, client: ReactDomClient, Control: unknown) {
  const node = (spec: ElementSpec): unknown => react.createElement(spec.element, spec.attributes, spec.text, ...(spec.children ?? []).map(node));
  const children = (value: unknown) =>
    Array.isArray(value) ? react.createElement(react.Fragment, null, ...(value as ElementSpec[]).map(node)) : node(value as ElementSpec);
  return (container: HTMLElement): VectorHost => {
    const root = client.createRoot(container);
    return {
      render: (props) =>
        root.render(react.createElement(Control, { ...props, ...(props.children === undefined ? {} : { children: children(props.children) }) })),
      unmount: () => root.unmount(),
    };
  };
}

/** Every vector of every control a set implements, run against the set's own component. */
async function vectorProblems(window: Window, react: React, client: ReactDomClient, loaded: LoadedSet[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const { set, module } of loaded) {
    if (!module) continue;
    for (const control of set.implements) {
      const held = vectors[control];
      for (const vector of held.vectors) {
        let found: string;
        try {
          found = stepsOf(await runVector({ window, control, base: held.props, vector, host: reactHost(react, client, module[control]) }));
        } catch (error) {
          found = `it threw: ${reasonOf(error)}`;
        }
        if (found !== "") problems.push({ check: "vector-failed", subject: `${control}: ${vector.name}`, message: found });
      }
    }
  }
  return problems;
}

async function stylesheetsOf(look: CheckedLook, sets: CheckedSet[]): Promise<{ read: ReadStylesheet[]; problems: Problem[] }> {
  const paths = [
    ...look.stylesheets,
    ...sets.flatMap((set) => set.files.siblings.filter((uri) => uri.endsWith(".css")).map((uri) => fileURLToPath(uri))),
  ];
  const read: ReadStylesheet[] = [];
  const problems: Problem[] = [];
  for (const path of [...new Set(paths)]) {
    const result = readStylesheet(await readFile(path, "utf8"));
    if (result.ok) read.push({ path, reading: result.reading });
    else problems.push({ check: "stylesheet-unparseable", subject: path, message: `It cannot be parsed: ${result.message}.` });
  }
  return { read, problems };
}

/** Every scene drawn by the renderer with the theme's controls, each snapshot recorded. */
async function sceneProblems(window: Window, rendererUrl: string, loaded: LoadedSet[], coverage: StyleCoverage): Promise<Problem[]> {
  const { mount } = (await import(rendererUrl)) as {
    mount: (root: HTMLElement, options: { loadModule: (url: string) => Promise<Record<string, unknown>> }) => { unmount(): void };
  };
  const renderer: SceneHost = (root, loadModule) => {
    const rendered = mount(root, { loadModule });
    return () => rendered.unmount();
  };
  const urlOf = (index: number) => `/_telo/conformance/controls/${index}.js`;
  const controls = { stylesheets: {}, sets: loaded.map(({ set }, index) => ({ module: urlOf(index), exports: set.implements })) };
  const load = (url: string) => {
    const index = loaded.findIndex((_, at) => urlOf(at) === url);
    if (index === -1) return undefined;
    const { module, failure } = loaded[index];
    return module ? Promise.resolve(module) : Promise.reject(new Error(failure));
  };
  const problems: Problem[] = [];
  for (const scene of scenes.scenes) {
    let found: string;
    try {
      found = stepsOf(
        await runScene({ window, scene, words: scenes.words, mount: renderer, controls, load, afterStep: () => coverage.record(window.document) }),
      );
    } catch (error) {
      found = `it threw: ${reasonOf(error)}`;
    }
    if (found !== "") problems.push({ check: "scene-failed", subject: scene.name, message: found });
  }
  return problems;
}

async function check(job: WindowJob, root: string, console: Console): Promise<Problem[]> {
  const page = openWindow(prepareWindow, console);
  const window = page.window;
  const staged = await stageWindow({ ...job.entries, sets: job.sets.map((set) => set.files) }, root);
  const react = (await import(staged.react)) as React;
  const client = (await import(staged.reactDomClient)) as ReactDomClient;
  const loaded = await loadSets(job.sets, staged.sets);
  const problems: Problem[] = loaded.flatMap(({ set, failure }) =>
    failure === undefined ? [] : [{ check: "controls-load-failed" as const, subject: set.owner, message: `${set.owner}: ${failure}.` }],
  );
  problems.push(...(await vectorProblems(window, react, client, loaded)));
  if (job.look) {
    const sheets = await stylesheetsOf(job.look, job.sets);
    const coverage = new StyleCoverage(sheets.read);
    problems.push(...(await sceneProblems(window, staged.renderer, loaded, coverage)));
    problems.push(...sheets.problems);
    problems.push(...coverage.problems({ parts: Object.values(parts.parts).flat(), reserved: parts.reserved }, job.look.unstyled));
    problems.push(...tokenProblems(job.look.tokens.names, tokenProperty, job.look.tokens.given, sheets.read));
  }
  await page.close();
  return problems;
}

if (!isMainThread && (workerData as Partial<WindowJob> | null)?.[CONFORMANCE_WORKER] === true) {
  // What the page, React and the controls write goes to the main thread, which
  // logs it: a runtime with no piped worker output would print it as its own.
  const output = windowConsole((line) => parentPort!.postMessage({ type: "output", line } satisfies WindowOutput));
  Object.defineProperty(globalThis, "console", { configurable: true, writable: true, value: output });
  let reply: WindowReply;
  const root = await mkdtemp(join(tmpdir(), "telo-ui-react-conformance-"));
  try {
    reply = { type: "done", problems: await check(workerData as WindowJob, root, output) };
  } catch (error) {
    reply = { type: "failed", message: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  // Removed before answering: the main thread stops this worker once it has the answer.
  await rm(root, { recursive: true, force: true });
  parentPort!.postMessage(reply);
}
