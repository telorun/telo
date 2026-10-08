# The component ABI — `ui_react-1`

What a custom component is written against. The ABI is React 19; a new React
major is a new ABI.

A component library declares `abi: ui_react-1` on its browser entry, and
publishes each component with a
[`Ui.ComponentExport`](../../ui/docs/component-export.md).

## A component

- A **named export** that is a React function component.
- It receives **exactly its declared properties**, resolved — a row-bound one
  against the row it is drawn for. They are ordinary React props and may
  change between renders.

```tsx
import { useHost } from "@telorun/ui-react";

export function StatusPill({ done }: { done?: boolean }) {
  const host = useHost();
  return <a href={host.href("/done")}>{done ? "Done" : "Open"}</a>;
}
```

## What it may leave to the host

An entry may list as `external` only these specifiers; the host supplies each
through the page's import map. Anything else a component imports is bundled
into it.

| Specifier | Is |
| --- | --- |
| `react` | React |
| `react/jsx-runtime` | the JSX runtime |
| `react-dom` | `createPortal`, `flushSync` and the rest of `react-dom` |
| `@telorun/ui-react` | the host module |

`react-dom/client` is not among them: a component never creates a root. The
renderer has an entry and a specifier of its own; it is internal, is not in
the import map, and is not something a component can import.

At start an application replaces a component whose entry declares another
ABI, or lists a specifier outside this set, with an `error` node:
`ERR_UI_COMPONENT_ABI_UNSUPPORTED`, `ERR_UI_COMPONENT_IMPORT_UNSUPPLIED`.

## The host

`@telorun/ui-react` exports exactly `useHost` — a hook callable in any
component the host renders, table cells included. It returns the host object
and re-renders the caller when `location` changes. The object has six fields:

| Field | |
| --- | --- |
| `location` | `{ path, search, hash }`. `path` is the current page's declared path, with the mount prefix removed. |
| `navigate` | `navigate(to, { replace? })` — go to an app-relative reference, resolved against the current page: `/done`, `/chat?c=7`, `?c=7`, `#top`. Adds a history entry, or replaces the current one with `replace: true`. A different page renders that page; the same page with a new query or fragment fetches nothing and re-renders the callers of `useHost`; a path no page declares renders the not-found page. A reference with a scheme or a host throws `TypeError`. While a form opened with `unsaved: confirm` holds unsaved input and the reference would close it, the navigation waits for the user's answer and does not happen if they stay. |
| `href` | `href(to)` — the same resolution, returned as the URL for an anchor, mount prefix included. |
| `fetch` | `fetch(…)` — the platform `fetch` as the application's own composites call it: same-origin credentials, origin-relative URLs. Returns the platform `Response` untouched, 401 and 403 included. A cross-origin request passes through unchanged. |
| `notifyChanged` | `notifyChanged(basePath)` — say that the collection at this `basePath` changed. Local to the document: every table whose `source.basePath` is exactly that string re-fetches its current view, and every `onChanged` listener for it runs. The renderer's own forms and deletes say the same after a successful write. |
| `onChanged` | `onChanged(basePath, listener)` — call `listener()` after each such change, whoever said it; returns the function that stops it. |

The declaration, which a library can type-check against:

```ts
/** Where the page is, in the application's own address space. */
export interface HostLocation {
  /** The current page's declared path, with the mount prefix removed. */
  readonly path: string;
  /** The query string, with its leading `?`, or `""`. */
  readonly search: string;
  /** The fragment, with its leading `#`, or `""`. */
  readonly hash: string;
}

/** What the host gives every component it renders. */
export interface Host {
  readonly location: HostLocation;
  /**
   * Go to an app-relative reference, resolved against the current page:
   * `/done`, `/chat?c=7`, `?c=7`, `#top`. Adds a history entry, or replaces the
   * current one. A reference with a scheme or a host throws `TypeError`.
   */
  navigate(to: string, options?: { replace?: boolean }): void;
  /** The same resolution as `navigate`, as the URL for an anchor — mount prefix included. */
  href(to: string): string;
  /**
   * The platform `fetch`, as the application's own composites call it:
   * same-origin credentials, origin-relative URLs. The `Response` is returned
   * untouched, 401 and 403 included.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Say that the collection at this `basePath` changed. */
  notifyChanged(basePath: string): void;
  /** Call `listener` after each such change; returns the function that stops it. */
  onChanged(basePath: string, listener: () => void): () => void;
}

/**
 * The host object. Callable in any component the host renders; the caller
 * re-renders when `location` changes.
 */
export function useHost(): Host;
```

## Two address spaces

| | Is relative to | Used by |
| --- | --- | --- |
| **The application's** | the mount: `/done` is the page `/done` wherever the application is mounted | `location`, `navigate`, `href`, a `link` node's `href`, an `image` node's `src` |
| **The origin's** | the origin: `/api/todos` is that path on the server | `fetch`, `notifyChanged`, `onChanged`, `source.basePath` |

A page is addressed in the first; a request is made in the second. An
app-relative `image.src` is in the first too, so an image an application ships
is served from a mount beneath its own — `Http.Static` at `/admin/files` for
an application at `/admin`.

## What the host guarantees

1. **Anchors.** A primary click with no modifier key, on an anchor with no
   `target` and no `download`, whose URL is under the mount and not under
   `/_telo`, navigates within the page — for an anchor a component renders
   and for a `link` node alike. Every other click is the browser's.
2. **Instance stability.** Re-rendering the same page keeps a component
   mounted, state and all, while its node's position, entry and export are
   unchanged. It unmounts on a navigation to another page, or when its
   `when:` turns false.
3. **Boundaries.** Each component has its own error boundary and its own
   suspense boundary. A throw replaces that component with an `error` node;
   while it loads or suspends, the `loading` part is shown.
4. **Stylesheets.** A stylesheet the entry's sources import is applied in the
   `telo.component` layer.

In the browser a component that cannot be shown is an `error` node, coded
`ERR_UI_COMPONENT_LOAD_FAILED` (its module did not load),
`ERR_UI_COMPONENT_EXPORT_MISSING` (the module has no such component) or
`ERR_UI_COMPONENT_FAILED` (it threw).

## How the ABI grows

For the life of `ui_react-1`:

- the export list of `@telorun/ui-react` is closed at `useHost`;
- the host object only gains fields, and a field listed above never changes
  meaning;
- the set of supplied specifiers only grows.

Anything else is a new ABI.

## Limits, and what to do instead

| There is no | Do |
| --- | --- |
| event wiring in the manifest | call `navigate`, `fetch`, `notifyChanged` from the component |
| shared store between components | hold state in the URL (`navigate("?c=7")`, read `location.search`), or in the API and `notifyChanged` |
| server push to a component | open your own stream with `fetch`, as below |
| access to another component's props or to the page document | declare the property and pass it |
| way to run before the page renders | a component runs when it is drawn |

## Recipe: a streaming chat

The API streams text from an `Http.Api` route; the component reads the body as
it arrives and keeps the conversation in the URL.

```tsx
import { useHost } from "@telorun/ui-react";
import { useState } from "react";

export function Chat({ basePath }: { basePath: string }) {
  const host = useHost();
  const conversation = new URLSearchParams(host.location.search).get("c") ?? "new";
  const [reply, setReply] = useState("");

  const send = async (text: string) => {
    const response = await host.fetch(`${basePath}/${conversation}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || !response.body) return setReply(`Failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      text += decoder.decode(part.value, { stream: true });
      setReply(text);
    }
    // A table listing conversations at this path refreshes itself.
    host.notifyChanged(basePath);
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); send(new FormData(event.currentTarget).get("text") as string); }}>
      <output>{reply}</output>
      <input name="text" />
    </form>
  );
}
```

## Recipe: an upload

A multipart `Http.Api` route takes the file; the table of uploads at the same
`basePath` re-fetches when it is done.

```tsx
import { useHost } from "@telorun/ui-react";

export function Upload({ basePath }: { basePath: string }) {
  const host = useHost();
  const upload = async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    const response = await host.fetch(basePath, { method: "POST", body });
    if (response.ok) host.notifyChanged(basePath);
  };
  return <input type="file" onChange={(event) => event.target.files?.[0] && upload(event.target.files[0])} />;
}
```
