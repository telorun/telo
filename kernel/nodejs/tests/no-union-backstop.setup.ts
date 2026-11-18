import { watchUnionBackstop, type UnionBackstop } from "@telorun/analyzer";
import { afterEach, beforeEach } from "vitest";

/**
 * The judge keeps a union undecided only when its validator lacks a document the
 * refusing instance holds. No kernel test may take that path: a refusal here is
 * decided as `telo check` decides it, or the validator is missing a document.
 */
let taken: UnionBackstop[] = [];
let stop: (() => void) | undefined;

beforeEach(() => {
  taken = [];
  stop = watchUnionBackstop((reason) => taken.push(reason));
});

afterEach(() => {
  stop?.();
  if (taken.length > 0) {
    throw new Error(`A union was kept undecided by the reporting backstop (${[...new Set(taken)].join(", ")}).`);
  }
});
