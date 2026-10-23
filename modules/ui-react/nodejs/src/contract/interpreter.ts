/**
 * The interpreter the controls contract is checked with: it drives a DOM window
 * the way a person would and observes what the page does, touching nothing but
 * that window. It never renders — a host draws a control, or mounts the
 * renderer — and it settles the page by turns of the window's own timer, so a
 * page that waits on a timer or a promise has moved on before anything is
 * looked at. What a simulated window does not do on its own, it does: Tab moves
 * the focus, Enter and Space press a button, a press focuses what it lands on,
 * a stylesheet link reports that it loaded.
 */
import controlsContract from "./controls.json" with { type: "json" };

/** Names one element of the page. Several keys narrow together; `index` picks
 *  among what is left, in document order. */
export interface Target {
  part?: string;
  /** The element's text, trimmed, equals this. */
  text?: string;
  role?: string;
  /** The element's tag name, lower case: `nav`, `a`, `button`. */
  tag?: string;
  id?: string;
  /** Attributes the element carries, each with exactly this value. */
  attributes?: Record<string, string>;
  within?: Target;
  index?: number;
  /** The element that has the focus. */
  focused?: true;
  /** An element the interpreter itself placed. */
  element?: "opener" | "container" | "body";
}

/** An element a control is given to draw, as data the host turns into one. */
export interface ElementSpec {
  element: string;
  attributes?: Record<string, string>;
  text?: string;
  children?: ElementSpec[];
}

/** A response the page's requests are answered with; `pending` never answers. */
export type CannedResponse = { status: number; body?: unknown } | { pending: true };

export interface Expectation {
  /** Exactly these intents, `[name, ...arguments]`, since the last expectation. */
  intents?: unknown[][];
  focus?: Target;
  /** The focus is inside this. */
  focusWithin?: Target;
  present?: Target[];
  absent?: Target[];
  attributes?: { of: Target; name: string; value: string | null }[];
  text?: { of: Target; value: string }[];
  /** These are drawn outside the application's element. */
  outside?: Target[];
}

/** One thing a person does, or one thing the page is held to. */
export type Step =
  | { click: Target }
  | { press: Target; pointer?: "mouse" | "touch" }
  /** A mouse pointer moved onto the target. */
  | { hover: Target }
  | { key: string; on?: Target; shift?: boolean }
  | { fill: Target; value: string }
  | { focus: Target }
  | { blur: Target }
  /** The target, and everything in it, is scrolled to its end. */
  | { scroll: Target }
  | { wait: number }
  | { props: Record<string, unknown> }
  | { respond: Record<string, CannedResponse> }
  | { expect: Expectation };

/** A behaviour a control is held to: props, then what a person does and what must follow. */
export interface Vector {
  name: string;
  /** Laid over the control's base props. */
  props?: Record<string, unknown>;
  /** Props whose intents are reported but not applied: what the renderer keeps as it is. */
  hold?: string[];
  steps: Step[];
}

export interface ControlVectors {
  /** The props every vector of the control starts from. */
  props: Record<string, unknown>;
  vectors: Vector[];
}

/** An application drawn by the renderer: its documents, the answers its
 *  requests get, and what a person does on it. */
export interface Scene {
  name: string;
  /** The address it is opened at, under a mount at the root. */
  path: string;
  /** Whether the viewport is below the application's breakpoint. */
  compact?: boolean;
  /** The application document, less its bundle, digest and words. */
  app: Record<string, unknown>;
  /** Each page document by path, less its bundle and digest. */
  pages: Record<string, Record<string, unknown>>;
  /** By `<METHOD> <path>`, the path exact or ending `/*` for anything beneath it. */
  responses: Record<string, CannedResponse>;
  /** The component modules the scene's nodes name, by URL, and what each exports. */
  modules?: Record<string, string[]>;
  steps: Step[];
}

export interface Problem {
  /** The step it was found at; `null` before the first. */
  step: number | null;
  message: string;
}

/** One control of the set, as the contract states it. */
export interface ControlContract {
  group: string;
  /** One of the layer controls, which a set implements all of or none of. */
  layer?: true;
  description: string;
  props: string[];
  /** The root parts the renderer may give it. */
  roots: string[];
  /** The prop naming its root part — `part` or `parts.root` — or none where it has one. */
  rootProp: string | null;
  /** The other parts the renderer names, by key of `parts`. */
  namedParts?: Record<string, string[]>;
  subParts: string[];
  /** Each intent, and the prop it sets. */
  intents: Record<string, string | null>;
  /** `$root` and `$<key>` stand for the parts the renderer gives. */
  states: { attribute: string; values: string[]; on: string[] }[];
  /** Whether the element carrying `id` is held to the semantics. */
  semantics: boolean;
  /** The parts drawn outside the application's element. */
  portal: string[];
}

/** The control set of a generation. */
export interface ControlsContract {
  generation: string;
  supplied: string[];
  stateAttributes: string[];
  icons: string[];
  controls: Record<string, ControlContract>;
}

const contract = controlsContract as unknown as ControlsContract;

/** A host drawing one control into a container. */
export interface VectorHost {
  /** Draw the control with these props, and again whenever they change.
   *  Every `ElementSpec` value, under `children` or at any depth of another
   *  prop's lists and plain objects (`withElements`), is the host's to turn
   *  into an element. */
  render(props: Record<string, unknown>): void;
  unmount(): void;
}

/** A host mounting the renderer onto a root element with a module loader;
 *  what it returns unmounts it. */
export type SceneHost = (root: HTMLElement, loadModule: (url: string) => Promise<Record<string, unknown>>) => () => void;

/** A window with the constructors of its own realm. */
type View = Window & typeof globalThis;

const TURNS = 10;
const SUPPLIED = "data-supplied";
/** What every layer a control draws at the end of `<body>` carries on its root. */
const LAYER = "data-telo-layer";
const TABBABLE = "button, [href], input, select, textarea, [tabindex]";

class StepFailure extends Error {}

interface Session {
  view: View;
  container: HTMLElement;
  opener?: HTMLElement;
}

async function settle(view: View, turns = TURNS): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((resolve) => view.setTimeout(resolve, 0));
}

const prepared = new WeakSet<View>();

/**
 * Give a window what the controls ask of a browser and a simulated one may not
 * have: size observation, scrolling into view, pointer capture — and report
 * every stylesheet link added to its document as loaded.
 */
export function prepareWindow(window: Window): void {
  const view = window as View;
  const scope = view as unknown as Record<string, any>;
  scope.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const element = scope.Element.prototype;
  element.scrollIntoView ??= () => {};
  element.hasPointerCapture ??= () => false;
  element.setPointerCapture ??= () => {};
  element.releasePointerCapture ??= () => {};
  if (prepared.has(view)) return;
  prepared.add(view);
  new view.MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added instanceof view.HTMLLinkElement && added.rel === "stylesheet") {
          view.queueMicrotask(() => added.dispatchEvent(new view.Event("load")));
        }
      }
    }
  }).observe(view.document.head, { childList: true });
}

const describe = (target: Target): string => JSON.stringify(target);

/** The child of `<body>` an element is drawn in, if any. */
function bodyChild(element: Element, document: Document): Element | null {
  let at: Element | null = element;
  while (at && at.parentElement !== document.body) at = at.parentElement;
  return at;
}

/**
 * Whether an element is part of a closing copy of a layer: left at the end of
 * `<body>` for its animation, taking no input and carrying no marker. What a
 * modal layer made unreachable beneath it — the application, a layer opened
 * before it — is still on the page.
 */
function closingCopy(element: Element, session: Session): boolean {
  const top = bodyChild(element, session.view.document);
  return !!top && top.hasAttribute("inert") && !top.hasAttribute(LAYER) && !top.hasAttribute(SUPPLIED) && top !== session.container;
}

function candidates(target: Target, session: Session): Element[] {
  const { view, container, opener } = session;
  const document = view.document;
  if (target.element === "opener") return opener ? [opener] : [];
  if (target.element === "container") return [container];
  if (target.element === "body") return [document.body];
  if (target.focused) return document.activeElement ? [document.activeElement] : [];
  if (target.id !== undefined) {
    const found = document.getElementById(target.id);
    return found ? [found] : [];
  }
  const scope: ParentNode = target.within ? resolve(target.within, session) : document;
  let found = [...scope.querySelectorAll(target.part !== undefined ? `[data-telo-part="${target.part}"]` : target.role !== undefined ? `[role="${target.role}"]` : "*")];
  if (target.role !== undefined) found = found.filter((element) => element.getAttribute("role") === target.role);
  if (target.tag !== undefined) found = found.filter((element) => element.localName === target.tag);
  if (target.text !== undefined) found = found.filter((element) => element.textContent?.trim() === target.text);
  for (const [name, value] of Object.entries(target.attributes ?? {})) found = found.filter((element) => element.getAttribute(name) === value);
  // A closing copy of an overlay takes no input and is no element of the page.
  return found.filter((element) => !closingCopy(element, session));
}

function resolve(target: Target, session: Session): HTMLElement {
  const found = candidates(target, session)[target.index ?? 0];
  if (!found) throw new StepFailure(`nothing on the page is ${describe(target)}`);
  return found as HTMLElement;
}

function hidden(element: Element, view: View): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at.hasAttribute("hidden") || at.hasAttribute("inert")) return true;
    const style = view.getComputedStyle(at);
    if (style.display === "none" || style.visibility === "hidden") return true;
  }
  return false;
}

function tabbables(view: View): HTMLElement[] {
  return [...view.document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.matches(":disabled") && !hidden(element, view),
  );
}

/** The focus moved by Tab, where nothing kept it from moving. */
function tab(view: View, backwards: boolean): void {
  const order = tabbables(view);
  if (order.length === 0) return;
  const at = order.indexOf(view.document.activeElement as HTMLElement);
  const next = at === -1 ? (backwards ? order.length - 1 : 0) : (at + (backwards ? -1 : 1) + order.length) % order.length;
  order[next].focus();
}

const pressable = (element: Element) =>
  element.matches("button, [role='button'], a[href], input[type='checkbox'], input[type='radio'], summary") && !element.matches(":disabled");

function pointer(view: View, type: string, element: Element, kind: "mouse" | "touch"): boolean {
  const event = new view.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: type.endsWith("down") ? 1 : 0 });
  Object.defineProperty(event, "pointerType", { value: kind });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return element.dispatchEvent(event);
}

/** A mouse pointer arriving on the element from outside the page, then moving on it. */
function hover(view: View, element: HTMLElement): void {
  for (const type of ["pointerover", "mouseover"]) pointer(view, type, element, "mouse");
  for (const type of ["pointerenter", "mouseenter"]) {
    const event = new view.MouseEvent(type, { bubbles: false, composed: true });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    element.dispatchEvent(event);
  }
  for (const type of ["pointermove", "mousemove"]) pointer(view, type, element, "mouse");
}

function click(view: View, element: HTMLElement): void {
  const kept = pointer(view, "pointerdown", element, "mouse");
  const focusable = element.closest<HTMLElement>(TABBABLE);
  if (pointer(view, "mousedown", element, "mouse") && kept && focusable && element.isConnected && !focusable.matches(":disabled")) focusable.focus();
  pointer(view, "pointerup", element, "mouse");
  pointer(view, "mouseup", element, "mouse");
  element.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0 }));
}

function key(view: View, name: string, element: Element, shift: boolean): void {
  const init = { key: name, bubbles: true, cancelable: true, composed: true, shiftKey: shift };
  const kept = element.dispatchEvent(new view.KeyboardEvent("keydown", init));
  if (kept && name === "Tab") tab(view, shift);
  else if (kept && name === "Enter" && pressable(element)) (element as HTMLElement).click();
  const released = element.dispatchEvent(new view.KeyboardEvent("keyup", init));
  if (kept && released && name === " " && pressable(element)) (element as HTMLElement).click();
}

function fill(view: View, element: HTMLElement, value: string): void {
  const prototype = Object.getPrototypeOf(element);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new StepFailure(`${element.tagName.toLowerCase()} takes no value`);
  setter.call(element, value);
  element.dispatchEvent(new view.Event("input", { bubbles: true }));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function expectations(expectation: Expectation, session: Session, intents: unknown[][], problem: (message: string) => void): void {
  const document = session.view.document;
  if (expectation.intents && !same(intents, expectation.intents)) {
    problem(`the intents reported were ${JSON.stringify(intents)}, not ${JSON.stringify(expectation.intents)}`);
  }
  if (expectation.focus) {
    const wanted = candidates(expectation.focus, session)[expectation.focus.index ?? 0];
    if (!wanted || document.activeElement !== wanted) {
      problem(`the focus is on ${focusName(document.activeElement)}, not on ${describe(expectation.focus)}`);
    }
  }
  if (expectation.focusWithin) {
    const around = candidates(expectation.focusWithin, session)[expectation.focusWithin.index ?? 0];
    if (!around || !around.contains(document.activeElement)) {
      problem(`the focus is on ${focusName(document.activeElement)}, not inside ${describe(expectation.focusWithin)}`);
    }
  }
  for (const target of expectation.present ?? []) if (candidates(target, session).length === 0) problem(`nothing is drawn as ${describe(target)}`);
  for (const target of expectation.absent ?? []) if (candidates(target, session).length > 0) problem(`${describe(target)} is still drawn`);
  for (const { of, name, value } of expectation.attributes ?? []) {
    const element = candidates(of, session)[of.index ?? 0];
    if (!element) problem(`nothing is drawn as ${describe(of)}`);
    else if (element.getAttribute(name) !== value) problem(`${describe(of)} has ${name}=${JSON.stringify(element.getAttribute(name))}, not ${JSON.stringify(value)}`);
  }
  for (const { of, value } of expectation.text ?? []) {
    const element = candidates(of, session)[of.index ?? 0];
    if (!element) problem(`nothing is drawn as ${describe(of)}`);
    else if (element.textContent?.trim() !== value) problem(`${describe(of)} reads ${JSON.stringify(element.textContent?.trim())}, not ${JSON.stringify(value)}`);
  }
  for (const target of expectation.outside ?? []) {
    const element = candidates(target, session)[target.index ?? 0];
    if (!element) problem(`nothing is drawn as ${describe(target)}`);
    else if (session.container.contains(element)) problem(`${describe(target)} is drawn inside the application's element`);
  }
}

function focusName(element: Element | null): string {
  if (!element || element === element.ownerDocument.body) return "nothing";
  const part = element.getAttribute("data-telo-part");
  return part ? `the '${part}' part` : `a ${element.tagName.toLowerCase()}${element.id ? ` '${element.id}'` : ""}`;
}

/** Perform one step that is not an expectation, a props change or an answer. */
async function perform(step: Step, session: Session): Promise<void> {
  const { view } = session;
  if ("click" in step) click(view, resolve(step.click, session));
  else if ("press" in step) pointer(view, "pointerdown", resolve(step.press, session), step.pointer ?? "mouse");
  else if ("hover" in step) hover(view, resolve(step.hover, session));
  else if ("key" in step) key(view, step.key, step.on ? resolve(step.on, session) : (view.document.activeElement ?? view.document.body), step.shift === true);
  else if ("fill" in step) fill(view, resolve(step.fill, session), step.value);
  else if ("focus" in step) resolve(step.focus, session).focus();
  else if ("blur" in step) {
    const element = resolve(step.blur, session);
    if (view.document.activeElement === element) element.blur();
    else element.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true }));
  } else if ("scroll" in step) {
    // Whichever element of it scrolls is the control's: each is told it reached its end.
    const scrolled = resolve(step.scroll, session);
    for (const element of [scrolled, ...scrolled.querySelectorAll("*")]) element.dispatchEvent(new view.Event("scroll"));
  }
  else if ("wait" in step) await new Promise<void>((done) => view.setTimeout(done, step.wait));
}

/** Mark every element a control is given as the renderer's own, not the control's. */
function supplied(spec: ElementSpec): ElementSpec {
  return { ...spec, attributes: { ...spec.attributes, [SUPPLIED]: "" }, ...(spec.children ? { children: spec.children.map(supplied) } : {}) };
}

const isElementSpec = (value: unknown): value is ElementSpec =>
  value !== null && typeof value === "object" && typeof (value as ElementSpec).element === "string";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function fromData(value: unknown, session: Session): unknown {
  if (Array.isArray(value)) return value.map((item) => fromData(item, session));
  if (value !== null && typeof value === "object" && (value as { $element?: unknown }).$element === "opener") return session.opener ?? null;
  if (isElementSpec(value)) return supplied(value);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromData(item, session)]));
  return value;
}

/** A value with every `ElementSpec` in it — itself, or at any depth of its
 *  lists and plain objects — turned into an element by `toElement`. */
export function withElements(value: unknown, toElement: (spec: ElementSpec) => unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => withElements(item, toElement));
  if (isElementSpec(value)) return toElement(value);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withElements(item, toElement)]));
  return value;
}

/** The parts a control may draw under these props: its root and named parts as
 *  the renderer gave them, and its fixed sub-parts. */
function allowedParts(control: ControlContract, props: Record<string, unknown>): Map<string, string> {
  const allowed = new Map<string, string>();
  const parts = props.parts as Record<string, string> | undefined;
  const root = control.rootProp === "part" ? (props.part as string) : control.rootProp === "parts.root" ? parts?.root : control.roots[0];
  if (root !== undefined) allowed.set(root, "$root");
  for (const key of Object.keys(control.namedParts ?? {})) if (parts?.[key] !== undefined) allowed.set(parts[key], `$${key}`);
  for (const part of control.subParts) if (!allowed.has(part)) allowed.set(part, part);
  return allowed;
}

/** What every step of every vector is held to: only the documented parts and
 *  states, the semantics on the element carrying `id`, and the overlay parts
 *  outside the application's element, each in a layer at the end of `<body>`
 *  whose root carries the layer marker. */
function contractProblems(control: ControlContract, props: Record<string, unknown>, session: Session): string[] {
  const { view, container } = session;
  const problems: string[] = [];
  const allowed = allowedParts(control, props);
  for (const element of view.document.querySelectorAll("[data-telo-part]")) {
    if (element.closest(`[${SUPPLIED}]`) || closingCopy(element, session)) continue;
    const part = element.getAttribute("data-telo-part") as string;
    const role = allowed.get(part);
    if (role === undefined) {
      problems.push(`it draws the part '${part}', which is not one of its own`);
      continue;
    }
    for (const attribute of contract.stateAttributes) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const documented = control.states.some(
        (state) => state.attribute === attribute && state.values.includes(value) && state.on.some((on) => on === role || on === part),
      );
      if (!documented) problems.push(`its '${part}' carries ${attribute}=${JSON.stringify(value)}, which it does not document`);
    }
    if (control.portal.includes(part)) {
      if (container.contains(element)) problems.push(`its '${part}' is drawn inside the application's element`);
      else if (!bodyChild(element, view.document)?.hasAttribute(LAYER)) problems.push(`its '${part}' is drawn in no layer: the root it is drawn in at the end of <body> does not carry ${LAYER}`);
    }
  }
  if (control.semantics && typeof props.id === "string") {
    const focusable = view.document.getElementById(props.id);
    if (!focusable) problems.push(`nothing carries the id '${props.id}'`);
    else {
      const flag = (name: string) => focusable.getAttribute(name) === "true";
      if (flag("aria-invalid") !== (props.invalid === true)) problems.push(`its element carrying the id says aria-invalid=${JSON.stringify(focusable.getAttribute("aria-invalid"))} while invalid is ${props.invalid === true}`);
      if ((flag("aria-required") || focusable.hasAttribute("required")) !== (props.required === true)) problems.push(`its element carrying the id does not say required as ${props.required === true}`);
      if ((focusable.matches(":disabled") || flag("aria-disabled")) !== (props.disabled === true)) problems.push(`its element carrying the id does not say disabled as ${props.disabled === true}`);
      if (typeof props.label === "string" && focusable.getAttribute("aria-label") !== props.label) problems.push(`its element carrying the id is not named '${props.label}'`);
      if (typeof props.describedBy === "string") {
        const relations = (focusable.getAttribute("aria-describedby") ?? "").split(/\s+/);
        for (const id of props.describedBy.split(/\s+/)) if (!relations.includes(id)) problems.push(`its element carrying the id is not described by '${id}'`);
      }
    }
  }
  return problems;
}

/**
 * Run one vector against a control: draw it with the vector's props, perform
 * each step, and hold the page to each expectation and, after every step, to
 * the contract. An intent the control reports is applied to the props it sets,
 * as the renderer would, unless the vector holds that prop. Answers what was
 * wrong; nothing for a control that meets the vector.
 */
export async function runVector(options: {
  window: Window;
  control: string;
  base: Record<string, unknown>;
  vector: Vector;
  host: (container: HTMLElement) => VectorHost;
}): Promise<Problem[]> {
  const { vector } = options;
  const view = options.window as View;
  const control = contract.controls[options.control];
  if (!control) return [{ step: null, message: `'${options.control}' is no control of ${contract.generation}` }];
  prepareWindow(view);
  const document = view.document;
  const opener = document.createElement("button");
  opener.setAttribute(SUPPLIED, "");
  opener.textContent = "Opener";
  const container = document.createElement("div");
  container.setAttribute("data-vector-app", "");
  document.body.append(opener, container);
  opener.focus();
  const session: Session = { view, container, opener };
  const problems: Problem[] = [];
  let intents: unknown[][] = [];
  let props: Record<string, unknown> = { ...options.base, ...vector.props };
  const host = options.host(container);
  const draw = () => {
    const given: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(props)) given[name] = fromData(value, session);
    for (const [intent, sets] of Object.entries(control.intents)) {
      if (props[intent] === false) {
        delete given[intent];
        continue;
      }
      given[intent] = (...args: unknown[]) => {
        // An argument left out and one passed as undefined are one report.
        while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
        intents.push([intent, ...args]);
        if (sets !== null && !(vector.hold ?? []).includes(sets)) {
          props = { ...props, [sets]: args[0] };
          draw();
        }
      };
    }
    host.render(given);
  };
  const check = (step: number | null) => {
    for (const message of contractProblems(control, props, session)) problems.push({ step, message });
  };
  try {
    draw();
    await settle(view);
    check(null);
    for (const [index, step] of vector.steps.entries()) {
      if ("props" in step) {
        props = { ...props, ...step.props };
        draw();
      } else if ("expect" in step) {
        expectations(step.expect, session, intents, (message) => problems.push({ step: index, message }));
        intents = [];
      } else if ("respond" in step) {
        problems.push({ step: index, message: "a vector has no requests to answer" });
      } else {
        await perform(step, session);
      }
      await settle(view);
      check(index);
    }
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    problems.push({ step: null, message: error.message });
  } finally {
    host.unmount();
    await settle(view);
    opener.remove();
    container.remove();
  }
  return problems;
}

function cannedFor(responses: Record<string, CannedResponse>, method: string, path: string): CannedResponse | undefined {
  const keys = Object.keys(responses);
  const exact = keys.find((key) => key === `${method} ${path}`);
  if (exact) return responses[exact];
  const beneath = keys.find((key) => key.endsWith("/*") && key.startsWith(`${method} `) && path.startsWith(key.slice(method.length + 1, -1)));
  return beneath === undefined ? undefined : responses[beneath];
}

/**
 * Run a scene: mount the renderer through `mount` on a root of its own, answer
 * its requests from the scene, perform each step — unless `steps` is false —
 * and tell `afterStep` once the page has settled after each, `null` for the
 * first drawing. A module a scene's component names exports a component that
 * draws nothing; any other module is asked of `load`. Answers what was wrong.
 */
export async function runScene(options: {
  window: Window;
  scene: Scene;
  words: Record<string, unknown>;
  mount: SceneHost;
  /** The application document's controls, in place of the scene's. */
  controls?: Record<string, unknown>;
  load?: (url: string) => Promise<Record<string, unknown>> | undefined;
  steps?: boolean;
  afterStep?: (step: number | null) => void;
}): Promise<Problem[]> {
  const { scene } = options;
  const view = options.window as View;
  prepareWindow(view);
  const document = view.document;
  const scope = view as unknown as Record<string, any>;
  const held = { fetch: scope.fetch, matchMedia: scope.matchMedia };
  const ResponseOf: typeof Response = scope.Response ?? Response;
  let responses = { ...scene.responses };
  const json = (body: unknown, status = 200) =>
    new ResponseOf(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const app = { ...scene.app, ...(options.controls ? { controls: options.controls } : {}), bundle: "scene", digest: "scene", words: options.words };
  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input instanceof Request ? input.url : input), view.location.href);
    if (url.pathname === "/_telo/ui/app") return json(app);
    if (url.pathname === "/_telo/ui/page") {
      const path = url.searchParams.get("path") ?? "";
      const page = scene.pages[path];
      return page ? json({ ...page, bundle: "scene", digest: `scene${path}`, path }) : json({ error: "NotFound", status: 404 }, 404);
    }
    const canned = cannedFor(responses, method, url.pathname);
    if (!canned) return json({ error: "NotFound", message: `The scene answers no ${method} ${url.pathname}.`, status: 404 }, 404);
    if ("pending" in canned) return new Promise<Response>(() => {});
    return json(canned.body, canned.status);
  };
  if (scene.compact !== undefined) {
    scope.matchMedia = (query: string) => ({ matches: scene.compact, media: query, addEventListener() {}, removeEventListener() {} });
  }
  view.history.replaceState(null, "", scene.path);
  const root = document.createElement("div");
  root.dataset.teloMount = "";
  root.dataset.teloBundle = "scene";
  document.body.append(root);
  const load = async (url: string): Promise<Record<string, unknown>> => {
    const names = scene.modules?.[url];
    if (names) return Object.fromEntries(names.map((name) => [name, () => null]));
    const other = options.load?.(url);
    if (!other) throw new Error(`The scene loads no module at '${url}'.`);
    return other;
  };
  const session: Session = { view, container: root };
  const problems: Problem[] = [];
  const unmount = options.mount(root, load);
  try {
    await settle(view);
    options.afterStep?.(null);
    if (options.steps === false) return problems;
    for (const [index, step] of scene.steps.entries()) {
      if ("expect" in step) {
        expectations(step.expect, session, [], (message) => problems.push({ step: index, message }));
      } else if ("respond" in step) {
        responses = { ...responses, ...step.respond };
      } else if ("props" in step) {
        problems.push({ step: index, message: "a scene has no props to change" });
      } else {
        await perform(step, session);
      }
      await settle(view);
      options.afterStep?.(index);
    }
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    problems.push({ step: null, message: error.message });
  } finally {
    unmount();
    await settle(view);
    root.remove();
    for (const leftover of document.body.querySelectorAll(":scope > *")) leftover.remove();
    scope.fetch = held.fetch;
    scope.matchMedia = held.matchMedia;
  }
  return problems;
}
