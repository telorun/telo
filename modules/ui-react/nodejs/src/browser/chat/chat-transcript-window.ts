/*!
 * Third-party code bundled into the renderer with the transcript's window, used under this licence.
 *
 * TanStack Virtual (@tanstack/react-virtual, @tanstack/virtual-core), MIT
 * Copyright (c) 2021-present Tanner Linsley
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { defaultRangeExtractor, observeElementOffset, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

/** The height a row is taken to have until it is drawn, in pixels. */
const ESTIMATE = 160;
/** Rows drawn beyond each edge of the viewport. */
const OVERSCAN = 4;
/** How near the end, in pixels, still counts as at the end. */
const SLACK = 24;

/** A row of the transcript: an entry's id, or a number for a row no entry is. */
export type RowKey = string | number;

export interface DrawnRow {
  index: number;
  /** The rows not drawn above or below it, as its block margins. */
  style?: CSSProperties;
}

export interface TranscriptWindow {
  /** Set on the scrolling transcript. */
  ref: (element: HTMLDivElement | null) => void;
  onScroll: () => void;
  /** The rows drawn, in order: those near the viewport and those kept, or every row while the transcript has no layout. */
  drawn: DrawnRow[];
  /** Set on each drawn row's element, which carries `data-index`; none while every row is drawn. */
  measure: ((element: Element | null) => void) | undefined;
  /** Hold the transcript at its end again, from the next drawing on. */
  follow: () => void;
}

const pixels = (value: string): number => Number.parseFloat(value) || 0;

/**
 * The rows of a transcript drawn near its viewport, the others standing in as
 * the block margins of the nearest drawn one, measured as they are drawn. It
 * holds the transcript at its end — before each paint, however its content or
 * its own size change — until the viewer scrolls up, and again once they scroll
 * back down; rows added or resized above what is in view keep it where it is.
 * `reachedTop` is called whenever the viewport is within its own height of the
 * top. Opening another `conversation` holds it at the end again.
 */
export function useTranscriptWindow({
  keys,
  keep,
  conversation,
  reachedTop,
}: {
  keys: readonly RowKey[];
  /** Rows drawn wherever they are: the one holding the focus, one being edited. */
  keep: ReadonlySet<RowKey>;
  conversation: string | undefined;
  reachedTop: () => void;
}): TranscriptWindow {
  const element = useRef<HTMLDivElement | null>(null);
  const [sized, setSized] = useState(false);
  const [metrics, setMetrics] = useState({ gap: 0, top: 0 });
  const following = useRef(true);
  const lastTop = useRef(0);
  /** Tells the window where the transcript was just scrolled to, ahead of its scroll event. */
  const report = useRef<(() => void) | undefined>(undefined);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const observed = useRef(new Set<Element>());
  const reached = useRef(reachedTop);
  reached.current = reachedTop;

  const getItemKey = useCallback((index: number) => keys[index] as RowKey, [keys]);
  const kept = useMemo(() => keys.flatMap((key, index) => (keep.has(key) ? [index] : [])), [keys, keep]);
  const rangeExtractor = useCallback(
    (range: Range) => (kept.length === 0 ? defaultRangeExtractor(range) : [...new Set([...defaultRangeExtractor(range), ...kept])].sort((a, b) => a - b)),
    [kept],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: keys.length,
    getScrollElement: () => element.current,
    estimateSize: () => ESTIMATE,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    gap: metrics.gap,
    scrollMargin: metrics.top,
    // A page prepended above keeps the row in view where it is.
    anchorTo: "end",
    observeElementOffset: (instance, changed) => {
      const scrolled = instance.scrollElement;
      report.current = scrolled ? () => changed(scrolled.scrollTop, false) : undefined;
      const stop = observeElementOffset(instance, changed);
      return () => {
        report.current = undefined;
        stop?.();
      };
    },
  });

  const pin = useCallback(() => {
    const scrolled = element.current;
    if (!scrolled || !following.current) return;
    scrolled.scrollTop = scrolled.scrollHeight;
    lastTop.current = scrolled.scrollTop;
    report.current?.();
  }, []);

  const nearTop = useCallback(() => {
    const scrolled = element.current;
    if (scrolled && scrolled.clientHeight > 0 && scrolled.scrollTop < scrolled.clientHeight) reached.current();
  }, []);

  const ref = useCallback((next: HTMLDivElement | null) => {
    element.current = next;
  }, []);

  // What the transcript's own layout gives the window: whether it has a viewport, its rows' gap, where its first row starts.
  useLayoutEffect(() => {
    const scrolled = element.current;
    if (!scrolled) return;
    const read = () => {
      const style = getComputedStyle(scrolled);
      const gap = pixels(style.rowGap);
      const top = pixels(style.paddingTop);
      setMetrics((now) => (now.gap === gap && now.top === top ? now : { gap, top }));
      setSized(scrolled.clientHeight > 0);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watching = new ResizeObserver((entries) =>
      flushSync(() => {
        if (entries.some((entry) => entry.target === scrolled)) read();
        pin();
      }),
    );
    watching.observe(scrolled);
    observer.current = watching;
    const watched = observed.current;
    return () => {
      watching.disconnect();
      observer.current = undefined;
      watched.clear();
    };
  }, [pin]);

  useLayoutEffect(() => {
    following.current = true;
  }, [conversation]);

  // After each drawing: what the transcript holds is watched for size changes, and it is held at its end.
  useLayoutEffect(() => {
    const scrolled = element.current;
    const watching = observer.current;
    if (scrolled && watching) {
      for (const each of observed.current) {
        if (each.parentElement === scrolled) continue;
        watching.unobserve(each);
        observed.current.delete(each);
      }
      for (const child of scrolled.children) {
        if (observed.current.has(child)) continue;
        watching.observe(child);
        observed.current.add(child);
      }
    }
    pin();
  });

  useEffect(nearTop);

  const onScroll = useCallback(() => {
    const scrolled = element.current;
    if (!scrolled) return;
    const top = scrolled.scrollTop;
    const distance = scrolled.scrollHeight - scrolled.clientHeight - top;
    // Only the viewer moves it up from where it was; content growing or shrinking at the end does not let go.
    if (top < lastTop.current - 1 && distance > 1) following.current = false;
    else if (distance <= SLACK) following.current = true;
    lastTop.current = top;
    nearTop();
  }, [nearTop]);

  const items = sized ? virtualizer.getVirtualItems() : undefined;
  let drawn: DrawnRow[];
  if (items === undefined) {
    drawn = keys.map((_, index) => ({ index }));
  } else {
    const { gap, top } = metrics;
    const end = virtualizer.getTotalSize() + top;
    let edge = top - gap;
    drawn = items.map((item, at) => {
      const above = Math.max(0, item.start - edge - gap);
      const below = at === items.length - 1 ? Math.max(0, end - item.end) : 0;
      edge = item.end;
      return {
        index: item.index,
        ...(above > 0 || below > 0 ? { style: { ...(above > 0 ? { marginTop: above } : {}), ...(below > 0 ? { marginBottom: below } : {}) } } : {}),
      };
    });
  }

  return {
    ref,
    onScroll,
    drawn,
    measure: sized ? virtualizer.measureElement : undefined,
    follow: () => {
      following.current = true;
    },
  };
}
