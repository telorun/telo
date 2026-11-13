//! What a program hosting the release commands supplies: its adapters (both
//! halves), where it writes, and the extra work its ecosystems need around the
//! generic commands. `telo-release` registers the shipped ecosystems; a host
//! serving more adds them and its own subcommands.

use std::rc::Rc;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::adapter::EcosystemAdapter;
use crate::ledger::LegacyLedgerLayers;
use crate::release_plan::ReleasePlan;
use crate::release_settings::ReadReleaseOptions;
use crate::ReleaseError;

use super::commands::{OptionSpec, ParsedArgs};
use super::evidence::{Argv, EvidenceAdapter};
use super::workspace::{MarkerReader, ReleaseWorkspace};

/// How text is painted for one stream.
#[derive(Debug, Clone, Copy)]
pub struct Style {
    pub on: bool,
}

impl Style {
    fn paint(self, code: u8, text: &str) -> String {
        if self.on {
            format!("\u{1b}[{code}m{text}\u{1b}[0m")
        } else {
            text.to_string()
        }
    }

    pub fn ok(self, text: &str) -> String {
        self.paint(32, text)
    }

    pub fn dim(self, text: &str) -> String {
        self.paint(2, text)
    }

    pub fn error(self, text: &str) -> String {
        self.paint(31, text)
    }

    pub fn warn(self, text: &str) -> String {
        self.paint(33, text)
    }
}

/// Stdout is the machine surface: under `-o json` it carries the `emit`
/// envelope and nothing else, so `line` goes silent there. Stderr is the human
/// surface in both formats.
pub trait ReleaseOutput {
    fn line(&self, text: &str);
    fn err_line(&self, text: &str);
    fn emit(&self, payload: Map<String, Value>);
    fn progress(&self, text: &str);
    fn style(&self) -> Style;
    fn err_style(&self) -> Style;
}

/// What `check`'s host gate found, judged with the plan the gate formed, and
/// whether it holds.
pub struct CheckOutcome {
    pub ok: bool,
    pub payload: Map<String, Value>,
}

pub type HostCheck = dyn Fn(&ReleaseWorkspace, &ReleasePlan, &Argv) -> Result<CheckOutcome, ReleaseError>;
pub type HostAfterApply = dyn Fn(&ReleaseWorkspace, &ReleasePlan, &Argv) -> Result<Vec<String>, ReleaseError>;

pub type HostRun = dyn Fn(&ReleaseHost, &ParsedArgs) -> Result<(), ReleaseError>;

/// A subcommand of the host's own.
pub struct HostSubcommand {
    pub name: String,
    pub describe: String,
    pub options: Vec<OptionSpec>,
    pub run: Box<HostRun>,
}

pub struct ReleaseHost {
    /// How the commands are invoked, for messages.
    pub command: String,
    pub adapters: Vec<Arc<dyn EcosystemAdapter>>,
    pub evidence: Vec<Arc<dyn EvidenceAdapter>>,
    /// Per ecosystem this host does not serve, the host that does.
    pub ecosystem_hosts: ReadReleaseOptions,
    /// How a pre-unit ledger's flat layers nest, when this host can say.
    pub ledger: Option<Box<LegacyLedgerLayers>>,
    pub read_marker: Option<Box<MarkerReader>>,
    pub output: Rc<dyn ReleaseOutput>,
    /// Options every subcommand takes beside the generic ones.
    pub global_options: Vec<OptionSpec>,
    /// Subcommands of this host's own.
    pub subcommands: Vec<HostSubcommand>,
    /// More of `check`'s gate.
    pub check: Option<Box<HostCheck>>,
    /// Writes `apply` makes once every planned unit carries its version.
    pub after_apply: Option<Box<HostAfterApply>>,
}
