//! No Node twin: the random source behind the time-based and random UUIDs, the role Node's
//! host fills with `crypto` — the operating system's cryptographic random bytes, read
//! through `getrandom` 0.4.3 with its default features off, which answers random bytes and
//! nothing else.
//!
//! The source is stateless: every draw is one read of the operating system for exactly
//! sixteen bytes, the shape of `uuid` 14.0.1's `rng` (`crypto.getRandomValues` on sixteen
//! bytes a call). Nothing holds random bytes between draws, so no host that forks can
//! duplicate them. There is no override: randomness is read, never supplied. A source
//! that fails is a typed failure, and the next draw reads it again.

/// The operating system's random source answered nothing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct RandomSourceUnavailable {
    pub(crate) cause: getrandom::Error,
}

const DRAW: usize = 16;

/// Sixteen random bytes.
pub(crate) fn random_bytes() -> Result<[u8; DRAW], RandomSourceUnavailable> {
    draw(|buffer| getrandom::fill(buffer).map_err(|cause| RandomSourceUnavailable { cause }))
}

/// Sixteen bytes, `read` filling them in one read of the source.
fn draw(read: impl FnOnce(&mut [u8]) -> Result<(), RandomSourceUnavailable>) -> Result<[u8; DRAW], RandomSourceUnavailable> {
    let mut bytes = [0; DRAW];
    read(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_draw_is_one_read_of_sixteen_bytes() {
        let mut reads = Vec::new();
        for draw_number in 0..3u8 {
            let drawn = draw(|buffer| {
                reads.push(buffer.len());
                buffer.fill(draw_number);
                Ok(())
            });
            assert_eq!(drawn, Ok([draw_number; 16]));
        }
        assert_eq!(reads, [16, 16, 16]);
    }

    #[test]
    fn a_failing_source_is_a_typed_failure_and_is_read_again() {
        let failed = draw(|_| Err(RandomSourceUnavailable { cause: getrandom::Error::UNSUPPORTED }));
        assert_eq!(failed, Err(RandomSourceUnavailable { cause: getrandom::Error::UNSUPPORTED }));
        let then = draw(|buffer| {
            buffer.fill(7);
            Ok(())
        });
        assert_eq!(then, Ok([7; 16]));
    }

    #[test]
    fn reads_the_operating_system() {
        let draws: Vec<[u8; 16]> = (0..64).map(|_| random_bytes().expect("the source answers")).collect();
        let distinct: std::collections::HashSet<_> = draws.iter().collect();
        assert_eq!(distinct.len(), 64);
    }
}
