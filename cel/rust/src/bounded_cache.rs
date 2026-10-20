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
use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;
use std::num::NonZeroUsize;

pub struct BoundedCache<K, V> {
    capacity: NonZeroUsize,
    held: HashMap<K, (V, u64)>,
    order: BTreeMap<u64, K>,
    clock: u64,
}

impl<K: Eq + Hash + Clone, V> BoundedCache<K, V> {
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self { capacity, held: HashMap::new(), order: BTreeMap::new(), clock: 0 }
    }

    pub fn capacity(&self) -> NonZeroUsize {
        self.capacity
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The value held for `key`, which becomes the most recently used. One hash lookup,
    /// and nothing allocated.
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        let stamp = self.tick();
        let (value, used) = self.held.get_mut(key)?;
        let held_key = self.order.remove(used).expect("every held entry is in the order");
        *used = stamp;
        self.order.insert(stamp, held_key);
        Some(&*value)
    }

    /// Holds `value` for `key` as the most recently used, dropping the least recently used
    /// entry when the cache would hold more than its capacity.
    pub fn set(&mut self, key: K, value: V) {
        let stamp = self.tick();
        if let Some((_, used)) = self.held.remove(&key) {
            self.order.remove(&used);
        }
        self.order.insert(stamp, key.clone());
        self.held.insert(key, (value, stamp));
        if self.held.len() > self.capacity.get() {
            let (_, oldest) = self.order.pop_first().expect("a cache past its capacity holds an entry");
            self.held.remove(&oldest);
        }
    }

    /// Forgets everything.
    pub fn clear(&mut self) {
        self.held.clear();
        self.order.clear();
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}
