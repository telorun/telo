//! Cooperative cancellation for Rust controllers — the read-only side of the
//! source/token split.
//!
//! Backend-agnostic: the token reads its cancellation state through a poll
//! closure supplied by whichever backend hosts the controller. The napi backend
//! wires it to the host's `InvokeContext`; a native Rust kernel wires it to its
//! own cancellation source (e.g. a shared atomic). Poll-only in the first pass —
//! controllers poll `is_cancelled()` between units of work; push delivery
//! (`onCancelled`) is a deferred addition.

use std::sync::Arc;

/// Read-only cancellation token handed to a controller inside its
/// [`InvokeContext`]. Backed by a poll closure supplied by the active backend.
///
/// Deliberately **not** `Clone`: a controller only ever borrows it (`&InvokeContext`)
/// for the duration of `invoke()`. Under the napi backend the poll closure
/// captures a JS handle valid only during that synchronous call, so cloning the
/// token out and polling it later would read a dead handle. Keeping it
/// un-clonable encodes "don't retain past the call" in the type.
pub struct CancellationToken {
    poll: Arc<dyn Fn() -> bool>,
}

impl CancellationToken {
    /// Construct a token from a poll closure. The backend wires this to its
    /// own cancellation source.
    pub fn from_poll(poll: impl Fn() -> bool + 'static) -> Self {
        Self {
            poll: Arc::new(poll),
        }
    }

    /// A token that is never cancelled — the sentinel used when no cancellation
    /// source has been wired for this invocation.
    pub fn never() -> Self {
        Self::from_poll(|| false)
    }

    /// Synchronous poll. `true` once the owning source has cancelled.
    pub fn is_cancelled(&self) -> bool {
        (self.poll)()
    }
}

/// Out-of-band second argument to [`Controller::invoke`](crate::Controller::invoke),
/// carrying the cancellation token. Intentionally a struct rather than a bare
/// token so future per-invoke concerns can join without a breaking signature
/// change — matching the Node SDK's `InvokeContext`.
pub struct InvokeContext {
    pub cancellation: CancellationToken,
}

impl InvokeContext {
    /// An `InvokeContext` whose token is never cancelled.
    pub fn never() -> Self {
        Self {
            cancellation: CancellationToken::never(),
        }
    }
}
