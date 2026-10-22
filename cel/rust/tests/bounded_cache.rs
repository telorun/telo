//! The bounded cache's eviction order: least recently used, a read counting as a use.
//!
//! No Node test file asserts it; the order is `bounded-cache.ts`'s, read from its source,
//! and these rows are this crate's own.

use std::num::NonZeroUsize;

use telorun_cel::BoundedCache;

fn cache(capacity: usize) -> BoundedCache<&'static str, u32> {
    BoundedCache::new(NonZeroUsize::new(capacity).expect("a capacity of one or more"))
}

#[test]
fn drops_the_least_recently_used_entry_past_its_capacity() {
    let mut held = cache(2);
    held.set("a", 1);
    held.set("b", 2);
    assert_eq!(held.get(&"a"), Some(&1));
    held.set("c", 3);
    assert_eq!(held.get(&"b"), None, "b was the least recently used");
    assert_eq!(held.get(&"a"), Some(&1));
    assert_eq!(held.get(&"c"), Some(&3));
    assert_eq!(held.len(), 2);
}

#[test]
fn replaces_a_key_written_again_as_the_most_recent() {
    let mut held = cache(2);
    held.set("a", 1);
    held.set("b", 2);
    held.set("a", 10);
    held.set("c", 3);
    assert_eq!(held.get(&"a"), Some(&10));
    assert_eq!(held.get(&"b"), None);
}

#[test]
fn forgets_everything_when_cleared() {
    let mut held = cache(3);
    held.set("a", 1);
    held.clear();
    assert!(held.is_empty());
    assert_eq!(held.get(&"a"), None);
    assert_eq!(held.capacity().get(), 3);
}

#[test]
fn reads_a_text_key_by_borrowed_text() {
    let mut held: BoundedCache<std::sync::Arc<str>, u32> =
        BoundedCache::new(NonZeroUsize::new(2).expect("a capacity of one or more"));
    held.set(std::sync::Arc::from("a"), 1);
    held.set(std::sync::Arc::from("b"), 2);
    assert_eq!(held.get("a"), Some(&1));
    held.set(std::sync::Arc::from("c"), 3);
    assert_eq!(held.get("b"), None, "b was the least recently used");
    assert_eq!(held.get("a"), Some(&1));
}

/// A recency-ordered `Vec`, the least recently used first.
struct Model {
    capacity: usize,
    entries: Vec<(u32, u32)>,
}

impl Model {
    fn get(&mut self, key: u32) -> Option<u32> {
        let at = self.entries.iter().position(|&(held, _)| held == key)?;
        let entry = self.entries.remove(at);
        self.entries.push(entry);
        Some(entry.1)
    }

    fn set(&mut self, key: u32, value: u32) {
        if let Some(at) = self.entries.iter().position(|&(held, _)| held == key) {
            self.entries.remove(at);
        }
        self.entries.push((key, value));
        if self.entries.len() > self.capacity {
            self.entries.remove(0);
        }
    }
}

#[test]
fn keeps_the_order_of_a_recency_list_through_a_long_mixed_sequence() {
    for capacity in [1usize, 2, 128] {
        let mut held: BoundedCache<u32, u32> =
            BoundedCache::new(NonZeroUsize::new(capacity).expect("a capacity of one or more"));
        let mut model = Model { capacity, entries: Vec::new() };
        let keys = (capacity * 3) as u64;
        let mut state: u64 = 0x2545_F491_4F6C_DD1D ^ capacity as u64;
        for step in 0..100_000u32 {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let roll = (state >> 33) % 100;
            let key = ((state >> 20) % keys) as u32;
            match roll {
                0..=44 => {
                    held.set(key, step);
                    model.set(key, step);
                }
                45..=98 => {
                    assert_eq!(held.get(&key).copied(), model.get(key), "get {key} at step {step}, capacity {capacity}");
                }
                _ => {
                    held.clear();
                    model.entries.clear();
                }
            }
            assert_eq!(held.len(), model.entries.len(), "len at step {step}, capacity {capacity}");
        }
    }
}
