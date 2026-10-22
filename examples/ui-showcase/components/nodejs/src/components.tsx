import { useHost } from "@telorun/ui-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./components.css";

/**
 * The page's language. The application writes the language it answered in on
 * `<html lang>`; a component's own words follow it, since only the manifest's
 * texts go through the translator.
 */
type Lang = "en" | "pl";
const pageLang = (): Lang => (document.documentElement.lang.toLowerCase().startsWith("pl") ? "pl" : "en");

/** One sentence in each language, with `{name}` holes filled from `values`. */
type Words = Record<string, { en: string; pl: string }>;
function say(words: Words, id: string, values: Record<string, string | number> = {}): string {
  return words[id][pageLang()].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

const DESK: Words = {
  where: { en: "This page is at", pl: "Ta strona to" },
  addTitle: { en: "Add a task to {project}", pl: "Dodaj zadanie do {project}" },
  title: { en: "Title", pl: "Tytuł" },
  add: { en: "Add", pl: "Dodaj" },
  sending: { en: "Sending…", pl: "Wysyłanie…" },
  added: { en: "Task {id} added to {project}.", pl: "Dodano zadanie {id} do {project}." },
  refused: { en: "Refused — {path}: {message}", pl: "Odrzucono — {path}: {message}" },
  failed: { en: "The request failed with status {status}.", pl: "Żądanie nie powiodło się, status {status}." },
  unanswered: { en: "No answer: {reason}", pl: "Brak odpowiedzi: {reason}" },
  countsTitle: { en: "How {project} stands", pl: "Stan projektu {project}" },
  counts: {
    en: "{todo} to do, {doing} in progress, {review} in review, {done} finished.",
    pl: "Do zrobienia: {todo}, w toku: {doing}, w przeglądzie: {review}, zakończone: {done}.",
  },
  reading: { en: "Reading…", pl: "Odczytywanie…" },
  changes: { en: "Changes to the tasks since this was drawn: {count}.", pl: "Zmiany zadań od narysowania: {count}." },
  stop: { en: "Stop listening", pl: "Przestań nasłuchiwać" },
  listen: { en: "Listen again", pl: "Nasłuchuj znowu" },
  showForm: { en: "Show the form", pl: "Pokaż formularz" },
  showCounts: { en: "Show the counts", pl: "Pokaż liczby" },
  toActions: { en: "Go to the actions page", pl: "Przejdź do strony akcji" },
  toTables: { en: "{project} on the tables page", pl: "{project} na stronie tabel" },
  leave: { en: "Navigate to https://telo.run", pl: "Przejdź do https://telo.run" },
  leaveRefused: { en: "navigate refused it — {name}: {message}", pl: "navigate odmówił — {name}: {message}" },
};

/** What the tasks of one project add up to, as `GET <countsPath>?code=` answers. */
interface Counts {
  todo: number;
  doing: number;
  review: number;
  done: number;
}

/** The answer to a request, as the desk shows it. */
type Outcome = { kind: "added"; id: number } | { kind: "refused"; path: string; message: string } | { kind: "failed"; status: number } | { kind: "unanswered"; reason: string };

/**
 * Uses every field of the host: shows where the page is, keeps which panel is
 * open in the address, moves to a page by `navigate` and by an anchor from
 * `href`, reads a project's counts with `fetch`, adds a task with `fetch` and
 * says the collection changed with `notifyChanged`, and listens for changes
 * with `onChanged` — its own and those of the tables on the page.
 */
export function TaskDesk({ basePath, countsPath, project }: { basePath: string; countsPath: string; project: string }) {
  const host = useHost();
  const panel = new URLSearchParams(host.location.search).get("desk") === "counts" ? "counts" : "add";
  const [title, setTitle] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [toast, setToast] = useState<string>();
  const [counts, setCounts] = useState<Counts | Outcome>();
  const [version, setVersion] = useState(0);
  const [changes, setChanges] = useState(0);
  const [listening, setListening] = useState(true);
  const [leaveRefused, setLeaveRefused] = useState<string>();

  useEffect(() => {
    if (!listening) return;
    return host.onChanged(basePath, () => {
      setChanges((count) => count + 1);
      setVersion((count) => count + 1);
    });
  }, [listening, basePath]);

  useEffect(() => {
    let current = true;
    setCounts(undefined);
    host.fetch(host.href(`${countsPath}?code=${encodeURIComponent(project)}`)).then(
      async (response) => {
        const read: Counts | Outcome = response.ok ? await response.json() : { kind: "failed", status: response.status };
        if (current) setCounts(read);
      },
      (error: unknown) => current && setCounts({ kind: "unanswered", reason: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [countsPath, project, version]);

  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const add = async () => {
    setSending(true);
    setOutcome(undefined);
    try {
      const response = await host.fetch(host.href(basePath), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, projectCode: project }),
      });
      if (response.ok) {
        const row = (await response.json()) as { id: number };
        setOutcome({ kind: "added", id: row.id });
        setToast(say(DESK, "added", { id: row.id, project }));
        setTitle("");
        host.notifyChanged(basePath);
      } else if (response.status === 400) {
        const envelope = (await response.json()) as { details: { path: string; message: string }[] };
        const detail = envelope.details[0];
        setOutcome({ kind: "refused", path: detail.path, message: detail.message });
      } else {
        setOutcome({ kind: "failed", status: response.status });
      }
    } catch (error) {
      setOutcome({ kind: "unanswered", reason: String(error) });
    } finally {
      setSending(false);
    }
  };

  const leave = () => {
    try {
      host.navigate("https://telo.run");
    } catch (error) {
      const failure = error as Error;
      setLeaveRefused(say(DESK, "leaveRefused", { name: failure.name, message: failure.message }));
    }
  };

  return (
    <section className="showcase-desk">
      <p className="showcase-desk-where">
        {say(DESK, "where")} <code>{host.location.path + host.location.search + host.location.hash}</code>
      </p>
      <nav className="showcase-desk-nav">
        <button type="button" aria-pressed={panel === "add"} onClick={() => host.navigate("?desk=add", { replace: true })}>
          {say(DESK, "showForm")}
        </button>
        <button type="button" aria-pressed={panel === "counts"} onClick={() => host.navigate("?desk=counts", { replace: true })}>
          {say(DESK, "showCounts")}
        </button>
        <button type="button" onClick={() => host.navigate("/actions")}>
          {say(DESK, "toActions")}
        </button>
        <a href={host.href(`/tables?project=${encodeURIComponent(project)}`)}>{say(DESK, "toTables", { project })}</a>
        <button type="button" onClick={leave}>
          {say(DESK, "leave")}
        </button>
      </nav>
      {leaveRefused && <p className="showcase-desk-note">{leaveRefused}</p>}
      {panel === "add" ? (
        <form
          className="showcase-desk-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label>
            {say(DESK, "addTitle", { project })}
            <input name="title" value={title} placeholder={say(DESK, "title")} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <button type="submit" disabled={sending}>
            {sending ? say(DESK, "sending") : say(DESK, "add")}
          </button>
          {outcome && <p className="showcase-desk-outcome" data-outcome={outcome.kind}>{describe(outcome, project)}</p>}
        </form>
      ) : (
        <div className="showcase-desk-counts">
          <strong>{say(DESK, "countsTitle", { project })}</strong>
          <p>{counts === undefined ? say(DESK, "reading") : "kind" in counts ? describe(counts, project) : say(DESK, "counts", { ...counts })}</p>
        </div>
      )}
      <p className="showcase-desk-changes">
        {say(DESK, "changes", { count: changes })}{" "}
        <button type="button" onClick={() => setListening(!listening)}>
          {listening ? say(DESK, "stop") : say(DESK, "listen")}
        </button>
      </p>
      {toast !== undefined &&
        createPortal(
          <div className="showcase-toast" role="status" data-telo-layer="">
            {toast}
          </div>,
          document.body,
        )}
    </section>
  );
}

function describe(outcome: Outcome, project: string): string {
  switch (outcome.kind) {
    case "added":
      return say(DESK, "added", { id: outcome.id, project });
    case "refused":
      return say(DESK, "refused", { path: outcome.path, message: outcome.message });
    case "failed":
      return say(DESK, "failed", { status: outcome.status });
    case "unanswered":
      return say(DESK, "unanswered", { reason: outcome.reason });
  }
}

const METER: Words = {
  label: { en: "Priority {priority} of 5", pl: "Priorytet {priority} z 5" },
  blocked: { en: "blocked", pl: "zablokowane" },
};

/** A task's priority as five pips, and whether it is blocked: a table cell given the row's values. */
export function PriorityMeter({ priority, blocked }: { priority: number; blocked?: boolean }) {
  return (
    <span className="showcase-meter" data-blocked={String(blocked === true)}>
      <span role="meter" aria-valuemin={1} aria-valuemax={5} aria-valuenow={priority} aria-label={say(METER, "label", { priority })} className="showcase-meter-pips">
        {[1, 2, 3, 4, 5].map((step) => (
          <i key={step} data-on={String(step <= priority)} />
        ))}
      </span>
      {blocked === true && <span className="showcase-meter-blocked">{say(METER, "blocked")}</span>}
    </span>
  );
}

/** The closed set of design tokens, by group, as `Ui.DesignTokens` names them. */
const TOKENS: [group: string, names: string[]][] = [
  ["color", ["background", "surface", "text", "muted", "border", "accent", "accent-text", "danger", "warning", "success"]],
  ["radius", ["sm", "md", "lg"]],
  ["space", ["xs", "sm", "md", "lg", "xl"]],
  ["shadow", ["sm", "md"]],
  ["font", ["body", "heading", "mono"]],
  ["font-size", ["sm", "md", "lg", "xl"]],
  ["line-height", ["body", "heading"]],
];

/** The custom property a token is projected to: dots become hyphens. */
const property = (token: string): string => `--telo-${token.replaceAll(".", "-")}`;

const SHEET: Words = {
  token: { en: "Token", pl: "Token" },
  property: { en: "Custom property", pl: "Właściwość CSS" },
  value: { en: "Value", pl: "Wartość" },
  sample: { en: "Sample", pl: "Próbka" },
  unset: { en: "(not set)", pl: "(nieustawiona)" },
  pangram: { en: "The quick brown fox jumps over the lazy dog.", pl: "Zażółć gęślą jaźń." },
};

/**
 * Every design token as this page's theme and brand give it: read from the
 * custom property the renderer projects it to, where the component is drawn,
 * with a sample drawn in it.
 */
export function TokenSheet() {
  const root = useRef<HTMLTableElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useLayoutEffect(() => {
    const style = getComputedStyle(root.current!);
    const read: Record<string, string> = {};
    for (const [group, names] of TOKENS) for (const name of names) read[`${group}.${name}`] = style.getPropertyValue(property(`${group}.${name}`)).trim();
    setValues(read);
  }, []);

  return (
    <table className="showcase-tokens" ref={root}>
      <thead>
        <tr>
          <th>{say(SHEET, "token")}</th>
          <th>{say(SHEET, "property")}</th>
          <th>{say(SHEET, "value")}</th>
          <th>{say(SHEET, "sample")}</th>
        </tr>
      </thead>
      {TOKENS.map(([group, names]) => (
        <tbody key={group}>
          {names.map((name) => {
            const token = `${group}.${name}`;
            const value = values[token] ?? "";
            return (
              <tr key={token}>
                <td>
                  <code>{token}</code>
                </td>
                <td>
                  <code>{property(token)}</code>
                </td>
                <td>{value === "" ? say(SHEET, "unset") : <code>{value}</code>}</td>
                <td>{sample(group, property(token))}</td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

/** A token drawn the way its group is used. */
function sample(group: string, custom: string): ReactNode {
  const read = `var(${custom})`;
  switch (group) {
    case "color":
      return <span className="showcase-swatch" style={{ background: read }} />;
    case "radius":
      return <span className="showcase-corner" style={{ borderRadius: read }} />;
    case "space":
      return <span className="showcase-space" style={{ inlineSize: read }} />;
    case "shadow":
      return <span className="showcase-shadow" style={{ boxShadow: read }} />;
    case "font":
      return <span style={{ fontFamily: read }}>{say(SHEET, "pangram")}</span>;
    case "font-size":
      return <span style={{ fontSize: read }}>Aa</span>;
    default:
      return (
        <span className="showcase-leading" style={{ lineHeight: read }}>
          {say(SHEET, "pangram")} {say(SHEET, "pangram")}
        </span>
      );
  }
}

/** The four faces a typeface token can carry, as CSS weights and styles. */
const FACES = [
  { id: "regular", weight: "400", style: "normal" },
  { id: "bold", weight: "700", style: "normal" },
  { id: "italic", weight: "400", style: "italic" },
  { id: "boldItalic", weight: "700", style: "italic" },
] as const;

const TYPE: Words = {
  body: { en: "Body text — {family}", pl: "Tekst — {family}" },
  heading: { en: "Headings — {family}", pl: "Nagłówki — {family}" },
  regular: { en: "Regular", pl: "Zwykły" },
  bold: { en: "Bold", pl: "Pogrubiony" },
  italic: { en: "Italic", pl: "Kursywa" },
  boldItalic: { en: "Bold italic", pl: "Pogrubiona kursywa" },
  served: { en: "served by this application: {status}", pl: "serwowany przez tę aplikację: {status}" },
  local: { en: "not served here — drawn from the viewer's own fonts", pl: "nie jest tu serwowany — rysowany z czcionek przeglądarki" },
  loaded: { en: "loaded", pl: "wczytany" },
  loading: { en: "loading", pl: "wczytywany" },
  unloaded: { en: "not loaded", pl: "niewczytany" },
  error: { en: "failed to load", pl: "nie udało się wczytać" },
  pangram: { en: "The quick brown fox jumps over the lazy dog.", pl: "Zażółć gęślą jaźń." },
};

/** A family as CSS names it, unquoted: the first name of a `font-family` list. */
const firstFamily = (list: string): string => list.split(",")[0].trim().replace(/^["']|["']$/g, "");
const weightOf = (weight: string): string => (weight === "normal" ? "400" : weight === "bold" ? "700" : weight);

/**
 * The body and heading typefaces in each of their four faces, and for each
 * face whether the application serves it: a face the page's `@font-face`
 * rules declare, with its loading state, or one the viewer's own fonts draw.
 */
export function TypefaceSamples() {
  const root = useRef<HTMLDivElement>(null);
  const [families, setFamilies] = useState<{ body: string; heading: string }>({ body: "", heading: "" });
  const [states, setStates] = useState<Record<string, FontFaceLoadStatus | "local">>({});

  useLayoutEffect(() => {
    const style = getComputedStyle(root.current!);
    setFamilies({ body: style.getPropertyValue("--telo-font-body").trim(), heading: style.getPropertyValue("--telo-font-heading").trim() });
  }, []);

  useEffect(() => {
    if (families.body === "") return;
    let current = true;
    const family = firstFamily(families.body);
    Promise.all(FACES.map((face) => document.fonts.load(`${face.style} ${face.weight} 1rem ${families.body}`))).then(
      () => {
        if (!current) return;
        const declared = [...document.fonts].filter((face) => firstFamily(face.family) === family);
        const read: Record<string, FontFaceLoadStatus | "local"> = {};
        for (const face of FACES) {
          const match = declared.find((candidate) => weightOf(candidate.weight) === face.weight && candidate.style === face.style);
          read[face.id] = match ? match.status : "local";
        }
        setStates(read);
      },
      (error: unknown) => {
        if (!current) return;
        setStates(Object.fromEntries(FACES.map((face) => [face.id, "error" as const])));
        console.error("Reading the page's typefaces failed:", error);
      },
    );
    return () => {
      current = false;
    };
  }, [families.body]);

  return (
    <div className="showcase-type" ref={root}>
      {(["body", "heading"] as const).map((role) => (
        <section key={role}>
          <h4 style={{ fontFamily: `var(--telo-font-${role})` }}>{say(TYPE, role, { family: families[role] })}</h4>
          <ul>
            {FACES.map((face) => (
              <li key={face.id} style={{ fontFamily: `var(--telo-font-${role})`, fontWeight: face.weight, fontStyle: face.style }}>
                <span className="showcase-type-face">{say(TYPE, face.id)}</span> {say(TYPE, "pangram")}
                {role === "body" && states[face.id] !== undefined && (
                  <small>{states[face.id] === "local" ? say(TYPE, "local") : say(TYPE, "served", { status: say(TYPE, states[face.id]) })}</small>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
