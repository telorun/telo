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
