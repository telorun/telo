//! A cache hit allocates nothing: the recency order is kept by slot index, so a read moves
//! an entry without building a node.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::num::NonZeroUsize;
use std::sync::Arc;

use telorun_cel::{re2_pattern, BoundedCache, Re2Flags};

struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

fn count() {
    // `try_with`: an allocation made while the thread's storage is torn down is not counted.
    let _ = ALLOCATIONS.try_with(|n| n.set(n.get() + 1));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count();
        System.realloc(pointer, layout, size)
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

fn allocations() -> usize {
    ALLOCATIONS.with(Cell::get)
}

#[test]
fn a_warmed_cache_takes_hits_without_allocating() {
    let mut held: BoundedCache<Arc<str>, u32> = BoundedCache::new(NonZeroUsize::new(128).expect("a capacity"));
    let keys: Vec<String> = (0..128).map(|i| format!("key{i}")).collect();
    for (i, key) in keys.iter().enumerate() {
        held.set(Arc::from(key.as_str()), i as u32);
    }
    let before = allocations();
    let mut sum = 0u64;
    for _ in 0..1000 {
        for key in &keys {
            sum += u64::from(*held.get(key.as_str()).expect("held"));
        }
    }
    assert_eq!(allocations() - before, 0, "128,000 hits (sum {sum})");
}

#[test]
fn a_warmed_pattern_takes_hits_without_allocating() {
    let patterns: Vec<String> = (0..128).map(|i| format!("a{i}b")).collect();
    for pattern in &patterns {
        re2_pattern(pattern, Re2Flags::NONE).expect("a valid pattern");
    }
    let before = allocations();
    for _ in 0..100 {
        for pattern in &patterns {
            re2_pattern(pattern, Re2Flags::NONE).expect("a valid pattern");
        }
    }
    assert_eq!(allocations() - before, 0, "12,800 hits");
}
