//! The Telo runner's session supervisor: the main process of every app
//! container, running one app process at a time as a runner asks over a
//! WebSocket (`packages/runner-core/specs/supervisor-protocol.md`).
//!
//! A crate with no Node twin: it must run inside an arbitrary app image with no
//! runtime in it — no shell, no libc, no Node, no telo — so it is one statically
//! linked executable. Unix only.
#![cfg(unix)]

pub mod bearer_token;
pub mod connection;
pub mod launcher;
pub mod output_ring;
pub mod protocol;
pub mod run_process;
pub mod serve;
pub mod supervisor;
pub mod supervisor_config;
pub mod supervisor_log;
