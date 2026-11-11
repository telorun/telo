//! `telo-desktop-host` — the webview helper `telo run` drives as the desktop host.
//!
//! The helper owns the native windows and tray icons of a desktop application and
//! is driven over a framed link on its stdin / stdout (README: "The link").
//!
//! **This crate is the exception to the Node-twin layout rule, like `telorun-abi`.**
//! It has no `cli/nodejs` counterpart: the Node half of the link is a client in the
//! CLI, and a native webview helper cannot be written in Node. It carries the CLI's
//! version (`scripts/version-line.mjs` moves its `Cargo.toml` and `Cargo.lock` entry
//! with the line), because a release publishes it beside the CLI and the two are
//! checked against each other at start.
//!
//! Everything here is plain Rust and builds without a native toolkit: the link, its
//! messages, the two-origin decision, the data-store identifier, the menu model and
//! the window / tray state machine over the [`helper::Backend`] seam. The toolkit
//! (`wry`, `tao`, `tray-icon`) lives behind the non-default `gui` feature, in `gui`.

pub mod envelope;
pub mod frame;
pub mod helper;
pub mod icon;
pub mod link;
pub mod menu;
pub mod messages;
pub mod navigation;
pub mod origin;
pub mod payload;
pub mod store;

#[cfg(feature = "gui")]
pub mod gui;

/// The helper's version: the release it was built in.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
