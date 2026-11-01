import { useCallback, useEffect, useRef, useState } from "react";

/** How far beyond the viewport a block of records is still drawn. */
const MARGIN = "100% 0px";

export interface WindowedBlock {
  /** Set on the block's element, drawn or not. */
  ref: (element: Element | null) => void;
  /** Whether the block's records are drawn; otherwise it stands in at `height`. */
  drawn: boolean;
  /** The height the block had when it was last drawn, in pixels. */
  height: number;
}

/**
 * One block of a listing's records — a page — drawn while it is near the
 * viewport and stood in for by its last height otherwise, so a long listing
 * draws only what is in view however far it is scrolled. A block that `keep`s
 * (it holds the focus, or an open surface) stays drawn. Where the browser has
 * no intersection observer, every block is drawn.
 */
export function useWindowedBlock(enabled: boolean, keep: boolean): WindowedBlock {
  const [near, setNear] = useState(true);
  const height = useRef(0);
  const element = useRef<Element | null>(null);
  const observer = useRef<IntersectionObserver | undefined>(undefined);

  const ref = useCallback(
    (next: Element | null) => {
      observer.current?.disconnect();
      observer.current = undefined;
      element.current = next;
      if (!next || !enabled || typeof IntersectionObserver === "undefined") return;
      observer.current = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          if (!entry.isIntersecting && element.current) height.current = element.current.getBoundingClientRect().height;
          setNear(entry.isIntersecting);
        },
        { rootMargin: MARGIN },
      );
      observer.current.observe(next);
    },
    [enabled],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return { ref, drawn: !enabled || near || keep, height: height.current };
}

/**
 * Call `reached` while the element is in view and `ready` — the end of a
 * listing paged by `scroll`, with a further page and none in flight — so a page
 * too short to push the end out of view is followed by the next. Nothing is
 * observed where the browser has no intersection observer; the element is
 * still pressed.
 */
export function useEndReached(enabled: boolean, ready: boolean, reached: () => void): (element: Element | null) => void {
  const latest = useRef(reached);
  latest.current = reached;
  const [inView, setInView] = useState(false);
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    if (enabled && inView && ready) latest.current();
  }, [enabled, inView, ready]);
  return useCallback(
    (element: Element | null) => {
      observer.current?.disconnect();
      observer.current = undefined;
      if (!element || !enabled || typeof IntersectionObserver === "undefined") return;
      observer.current = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setInView(entry.isIntersecting);
      });
      observer.current.observe(element);
    },
    [enabled],
  );
}
