//! No Node twin: the clock the catalog reads, the role Node's host fills with `Date.now()`
//! — the system clock as whole milliseconds since the epoch, floored, so an instant before
//! the epoch reads as a negative count. There is no override: a clock is read, never
//! supplied.

use std::time::{SystemTime, UNIX_EPOCH};

/// The system clock now, in whole milliseconds since the epoch.
pub(crate) fn now_millis() -> i64 {
    millis_since_epoch(SystemTime::now())
}

/// A system time as whole milliseconds since the epoch, floored; a time beyond what an
/// `i64` of milliseconds holds, some 292 million years away, saturates.
fn millis_since_epoch(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).unwrap_or(i64::MAX),
        Err(before) => {
            let before = before.duration();
            let whole = before.as_millis() + u128::from(before.subsec_nanos() % 1_000_000 != 0);
            i64::try_from(whole).map_or(i64::MIN, |whole| -whole)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn reads_whole_milliseconds_floored() {
        let at = |nanos: i64| {
            let offset = Duration::from_nanos(nanos.unsigned_abs());
            millis_since_epoch(if nanos < 0 { UNIX_EPOCH - offset } else { UNIX_EPOCH + offset })
        };
        assert_eq!(at(0), 0);
        assert_eq!(at(999_999), 0);
        assert_eq!(at(1_000_000), 1);
        assert_eq!(at(1_500_000), 1);
        assert_eq!(at(-1), -1);
        assert_eq!(at(-1_000_000), -1);
        assert_eq!(at(-1_000_001), -2);
        assert_eq!(at(-1_500_000), -2);
        assert_eq!(at(1_788_667_200_123_456_789), 1_788_667_200_123);
    }

    #[test]
    fn reads_the_system_clock() {
        let before = millis_since_epoch(SystemTime::now());
        let now = now_millis();
        assert!(now >= before && now - before < 60_000);
    }
}
