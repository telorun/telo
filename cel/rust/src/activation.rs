//! The activation: the values an expression reads names from — `activation.ts`.
//!
//! A read is the activation's own entry or nothing: a name it does not hold is the
//! `no_such_variable` error value at the read, which short-circuits like any other. A
//! dotted declaration is one name, so a host may hold `a.b.c` as well as `a`; which of
//! them a chain reads is decided by the evaluator, longest prefix first, exactly as the
//! checker types it.
//!
//! A host composes layered scopes by implementing [`CelActivation`] over its own layers,
//! never by copying them into one.
//!
//! Node items with no twin in this file:
//! - `activationHolds` — it is [`CelActivation::read`] answering a value.
//! - The own-property rule — a Rust map holds no inherited entry, so every read is an
//!   own one.

use std::collections::{BTreeMap, HashMap};
use std::hash::BuildHasher;

use telorun_cel_value::{CelRecord, CelValue, PropertyMap};

/// What a host binds names to.
pub trait CelActivation {
    /// The value bound to `name`, or nothing where the activation holds no such name.
    fn read(&self, name: &str) -> Option<CelValue>;
}

impl CelActivation for PropertyMap<CelValue> {
    fn read(&self, name: &str) -> Option<CelValue> {
        self.get(name).cloned()
    }
}

impl CelActivation for CelRecord {
    fn read(&self, name: &str) -> Option<CelValue> {
        self.get(name).cloned()
    }
}

impl<S: BuildHasher> CelActivation for HashMap<String, CelValue, S> {
    fn read(&self, name: &str) -> Option<CelValue> {
        self.get(name).cloned()
    }
}

impl CelActivation for BTreeMap<String, CelValue> {
    fn read(&self, name: &str) -> Option<CelValue> {
        self.get(name).cloned()
    }
}

/// The activation that holds nothing.
impl CelActivation for () {
    #[allow(unused_variables)]
    fn read(&self, name: &str) -> Option<CelValue> {
        None
    }
}
