//! THE closest candidate to a misspelled name, or none. Mirrors
//! `../../nodejs/src/nearest-name.ts`: a tie suggests nothing, and the threshold
//! scales with the name but is capped (`min(3, len/3)`, and nothing under 1), so
//! both halves offer the same suggestion in the same message.

use crate::levenshtein::distance;

pub fn nearest_name<'a>(target: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    if target.is_empty() {
        return None;
    }
    let threshold = 3.min(target.chars().count() / 3);
    if threshold < 1 {
        return None;
    }
    let mut best: Option<&'a str> = None;
    let mut best_distance = threshold + 1;
    let mut tied = false;
    for candidate in candidates {
        let d = distance(target, candidate);
        if d < best_distance {
            best = Some(candidate);
            best_distance = d;
            tied = false;
        } else if d == best_distance {
            tied = true;
        }
    }
    if best_distance > threshold || tied {
        None
    } else {
        best
    }
}
