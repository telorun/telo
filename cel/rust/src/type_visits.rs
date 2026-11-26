//! How many types the whole-type walks have visited — `type-visits.ts`, counted per
//! thread where Node counts per process, so a gate reads only the work it measures.

use std::cell::Cell;

thread_local! {
    static VISITS: Cell<u64> = const { Cell::new(0) };
}

/// One visit of a type, or of a pair of types, by a whole-type walk.
pub(crate) fn count_type_visit() {
    VISITS.with(|visits| visits.set(visits.get() + 1));
}

/// Every visit counted on this thread so far; a gate reads the difference across the work it measures.
#[cfg(test)]
pub(crate) fn type_visits() -> u64 {
    VISITS.with(Cell::get)
}
