import { createContext, useContext, useState } from "react";

/** What the viewer set inside the stored entries of the conversation shown, by entry and slot. */
export const EntryStateContext = createContext<Map<string, unknown> | undefined>(undefined);

/** The stored entry being drawn; none for the live turn. */
export const EntryOwnerContext = createContext<string | undefined>(undefined);

/**
 * A piece of state of a stored entry's part — a panel opened, a reason typed —
 * kept by the chat rather than the part, so it is the same when the entry is
 * drawn again after scrolling out of view. The live turn's is the part's own.
 */
export function useEntryState<T>(slot: string, initial: T): [T, (next: T) => void] {
  const store = useContext(EntryStateContext);
  const owner = useContext(EntryOwnerContext);
  const key = store === undefined || owner === undefined ? undefined : `${owner}\n${slot}`;
  const [value, setValue] = useState<T>(() => (key !== undefined && store?.has(key) ? (store.get(key) as T) : initial));
  const set = (next: T) => {
    if (key !== undefined) store?.set(key, next);
    setValue(next);
  };
  return [value, set];
}
