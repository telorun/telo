//! A bounded least-recently-used cache — `bounded-cache.ts`.
//!
//! Every in-process cache in this engine is bounded with a declared capacity: a compiled
//! pattern is keyed on text a request can influence, so an unbounded cache is a memory
//! leak with an author's input as its key. A read moves its entry to the most recent end,
//! and a write past the capacity drops the least recently used entry.
//!
//! Node items with no twin: the `RangeError` for a capacity below one — the capacity is a
//! `NonZeroUsize`, so a cache of none is unrepresentable.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::num::NonZeroUsize;

/// A slot of the recency list, linked to its neighbours by slot index.
struct Node<K, V> {
    key: K,
    value: V,
    newer: Option<usize>,
    older: Option<usize>,
}

pub struct BoundedCache<K, V> {
    capacity: NonZeroUsize,
    slots: HashMap<K, usize>,
    nodes: Vec<Node<K, V>>,
    newest: Option<usize>,
    oldest: Option<usize>,
}

impl<K: Eq + Hash + Clone, V> BoundedCache<K, V> {
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self { capacity, slots: HashMap::new(), nodes: Vec::new(), newest: None, oldest: None }
    }

    pub fn capacity(&self) -> NonZeroUsize {
        self.capacity
    }

    fn unlink(&mut self, slot: usize) {
        let (newer, older) = (self.nodes[slot].newer, self.nodes[slot].older);
        match newer {
            Some(newer) => self.nodes[newer].older = older,
            None => self.newest = older,
        }
        match older {
            Some(older) => self.nodes[older].newer = newer,
            None => self.oldest = newer,
        }
    }

    fn link_newest(&mut self, slot: usize) {
        self.nodes[slot].newer = None;
        self.nodes[slot].older = self.newest;
        match self.newest {
            Some(newest) => self.nodes[newest].newer = Some(slot),
            None => self.oldest = Some(slot),
        }
        self.newest = Some(slot);
    }

    /// The value held for `key`, which becomes the most recently used. One hash lookup,
    /// and nothing allocated.
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        let slot = *self.slots.get(key)?;
        if self.newest != Some(slot) {
            self.unlink(slot);
            self.link_newest(slot);
        }
        Some(&self.nodes[slot].value)
    }

    /// Holds `value` for `key` as the most recently used, dropping the least recently used
    /// entry when the cache would hold more than its capacity.
    pub fn set(&mut self, key: K, value: V) {
        if let Some(&slot) = self.slots.get(&key) {
            self.nodes[slot].value = value;
            if self.newest != Some(slot) {
                self.unlink(slot);
                self.link_newest(slot);
            }
            return;
        }
        let slot = if self.nodes.len() < self.capacity.get() {
            self.nodes.push(Node { key: key.clone(), value, newer: None, older: None });
            self.nodes.len() - 1
        } else {
            let slot = self.oldest.expect("a full cache holds an entry");
            self.unlink(slot);
            self.slots.remove(&self.nodes[slot].key);
            self.nodes[slot].key = key.clone();
            self.nodes[slot].value = value;
            slot
        };
        self.slots.insert(key, slot);
        self.link_newest(slot);
    }

    /// Forgets everything.
    pub fn clear(&mut self) {
        self.slots.clear();
        self.nodes.clear();
        self.newest = None;
        self.oldest = None;
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}
