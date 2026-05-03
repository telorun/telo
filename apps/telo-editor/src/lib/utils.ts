import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(...inputs))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function shallowEqualObject(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  // Order-sensitive: a key-set equality check would miss external reorderings
  // (file reload, source edit) that consumers like MapField need to resync to.
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (key !== bKeys[i]) return false;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}
