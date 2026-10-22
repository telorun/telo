import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

const TYPEAHEAD_PAUSE = 1000;

/**
 * The focus moving among a list's entries, each focusable but outside the Tab
 * order: the arrows, Home and End move it, typing moves it to the next entry
 * starting with what was typed, and a pointer over an entry moves it there.
 * The entry with the focus is the highlighted one.
 */
export function useListFocus(list: RefObject<HTMLElement | null>, entry: string) {
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const entries = () => [...(list.current?.querySelectorAll<HTMLElement>(entry) ?? [])];

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const all = entries();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = at === -1 ? 0 : Math.min(at + 1, all.length - 1);
    else if (event.key === "ArrowUp") next = at === -1 ? all.length - 1 : Math.max(at - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = all.length - 1;
    else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - typed.current.at < TYPEAHEAD_PAUSE ? typed.current.text : "") + event.key.toLowerCase();
      typed.current = { text, at: now };
      // The same letter again steps to the next entry starting with it.
      const search = [...text].every((letter) => letter === text[0]) ? text[0] : text;
      const from = search.length === 1 ? at + 1 : Math.max(at, 0);
      const order = [...all.slice(from), ...all.slice(0, from)];
      const found = order.find((candidate) => candidate.textContent?.trim().toLowerCase().startsWith(search));
      if (found) next = all.indexOf(found);
    }
    if (next === undefined) return;
    event.preventDefault();
    all[next].focus();
  };

  /** What an entry carries to take part: its highlight, and the focus following the pointer. */
  const entryProps = (index: number) => ({
    tabIndex: -1,
    "data-highlighted": highlighted === index ? "" : undefined,
    onFocus: () => setHighlighted(index),
    onBlur: () => setHighlighted((held) => (held === index ? null : held)),
    onPointerMove: (event: { currentTarget: HTMLElement }) => {
      if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
    },
  });

  return { onKeyDown, entryProps };
}
