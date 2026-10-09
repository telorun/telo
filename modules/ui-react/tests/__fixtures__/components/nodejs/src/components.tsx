import { useHost } from "@telorun/ui-react";
import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import "./components.css";

/** A row's state as a pill. */
export function StatusPill({ done, label }: { done?: boolean; label?: string }) {
  return (
    <span className="fixture-pill" data-done={String(done === true)}>
      {label ?? (done ? "Done" : "Open")}
    </span>
  );
}

/** Holds state of its own, and throws when told to. */
export function Counter({ step, fail }: { step: number; fail?: boolean }) {
  const [count, setCount] = useState(0);
  if (fail) throw new Error("The counter was told to fail.");
  return (
    <button type="button" data-fixture="counter" data-step={step} onClick={() => setCount(count + step)}>
      {count}
    </button>
  );
}

/** Uses everything the host offers, one control per capability. */
export function HostProbe({ basePath }: { basePath: string }) {
  const host = useHost();
  const [chunks, setChunks] = useState<string[]>([]);
  const [status, setStatus] = useState<number>();
  const [changes, setChanges] = useState(0);
  const [listening, setListening] = useState(true);
  const [refused, setRefused] = useState("");
  const [flushed, setFlushed] = useState("");
  const [text, setText] = useState("");
  const measured = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!listening) return;
    return host.onChanged(basePath, () => setChanges((count) => count + 1));
  }, [listening, basePath]);

  const read = async () => {
    const response = await host.fetch(basePath);
    setStatus(response.status);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      received.push(decoder.decode(part.value, { stream: true }));
    }
    setChunks(received);
  };

  const flush = () => {
    flushSync(() => setText("flushed"));
    // The DOM already holds the update when flushSync returns.
    setFlushed(measured.current?.textContent ?? "");
  };

  const external = () => {
    try {
      host.navigate("https://example.com/");
    } catch (error) {
      setRefused(error instanceof TypeError ? "TypeError" : String(error));
    }
  };

  return (
    <div data-fixture="probe">
      <span data-fixture="location">{host.location.path + host.location.search + host.location.hash}</span>
      <span data-fixture="keys">{Object.keys(host).join(",")}</span>
      <span data-fixture="href">{host.href("/done?x=1")}</span>
      <button type="button" data-fixture="query" onClick={() => host.navigate("?c=2")}>query</button>
      <button type="button" data-fixture="page" onClick={() => host.navigate("/done")}>page</button>
      <button type="button" data-fixture="nowhere" onClick={() => host.navigate("/nowhere")}>nowhere</button>
      <button type="button" data-fixture="replace" onClick={() => host.navigate("?c=3", { replace: true })}>replace</button>
      <button type="button" data-fixture="replace-page" onClick={() => host.navigate("/done", { replace: true })}>replace page</button>
      <button type="button" data-fixture="external" onClick={external}>external</button>
      <span data-fixture="refused">{refused}</span>
      <a data-fixture="anchor" href={host.href("/done")}>done</a>
      <a data-fixture="outside" href="https://example.com/">outside</a>
      <button type="button" data-fixture="read" onClick={read}>read</button>
      <span data-fixture="status">{status}</span>
      <span data-fixture="chunks">{chunks.join("|")}</span>
      <button type="button" data-fixture="notify" onClick={() => host.notifyChanged(basePath)}>notify</button>
      <button type="button" data-fixture="stop" onClick={() => setListening(false)}>stop</button>
      <span data-fixture="changes">{changes}</span>
      <button type="button" data-fixture="flush" onClick={flush}>flush</button>
      <span data-fixture="text" ref={measured}>{text}</span>
      <span data-fixture="flushed">{flushed}</span>
      {createPortal(<div data-fixture="portal">in a portal</div>, document.body)}
    </div>
  );
}
