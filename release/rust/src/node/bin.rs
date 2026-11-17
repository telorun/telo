//! `telo-release` — the release commands over the ecosystems this crate ships
//! (npm, cargo, docker, helm, pypi). A Telo module is served by `telo release`.

use std::cell::Cell;
use std::io::{IsTerminal, Write};
use std::rc::Rc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use telorun_release::node::commands::release_commands_with;
use telorun_release::node::host::{ReleaseHost, ReleaseOutput, Style};
use telorun_release::node::shipped_evidence;
use telorun_release::release_settings::ReadReleaseOptions;
use telorun_release::shipped_adapters;

/// What `-o` selects: `markdown` is taken only by the plan commands.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Text,
    Json,
    Markdown,
}

struct Terminal {
    format: Cell<Format>,
    progress_shown: Cell<bool>,
    stdout_style: Style,
    stderr_style: Style,
    stderr_tty: bool,
}

impl Terminal {
    fn end_progress(&self) {
        if self.progress_shown.replace(false) {
            let _ = std::io::stderr().write_all(b"\r\x1b[K");
        }
    }
}

impl ReleaseOutput for Terminal {
    fn line(&self, text: &str) {
        if self.format.get() == Format::Text {
            let _ = writeln!(std::io::stdout(), "{text}");
        }
    }

    fn err_line(&self, text: &str) {
        self.end_progress();
        let _ = writeln!(std::io::stderr(), "{text}");
    }

    fn emit(&self, payload: Map<String, Value>) {
        if self.format.get() == Format::Json {
            let text = serde_json::to_string_pretty(&Value::Object(payload)).unwrap_or_default();
            let _ = writeln!(std::io::stdout(), "{text}");
        }
    }

    fn document(&self, text: &str) {
        self.end_progress();
        let _ = std::io::stdout().write_all(text.as_bytes());
    }

    fn progress(&self, text: &str) {
        if !self.stderr_tty {
            return;
        }
        let _ = write!(std::io::stderr(), "\r\x1b[K{text}");
        self.progress_shown.set(true);
    }

    fn style(&self) -> Style {
        self.stdout_style
    }

    fn err_style(&self) -> Style {
        self.stderr_style
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let colors = std::env::var_os("NO_COLOR").is_none();
    let terminal = Rc::new(Terminal {
        format: Cell::new(Format::Text),
        progress_shown: Cell::new(false),
        stdout_style: Style { on: colors && std::io::stdout().is_terminal() },
        stderr_style: Style { on: colors && std::io::stderr().is_terminal() },
        stderr_tty: std::io::stderr().is_terminal(),
    });
    let mut hosts = IndexMap::new();
    hosts.insert("telo".to_string(), "the `telo` CLI (`telo release`), which serves Telo modules".to_string());
    let host = ReleaseHost {
        command: "telo-release".into(),
        adapters: shipped_adapters(),
        evidence: shipped_evidence(),
        ecosystem_hosts: ReadReleaseOptions { ecosystem_hosts: hosts },
        ledger: None,
        read_marker: None,
        output: terminal.clone(),
        global_options: Vec::new(),
        subcommands: Vec::new(),
        check: None,
        after_apply: None,
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    let code = release_commands_with(&host, &args, &cwd, &|parsed| {
        terminal.format.set(match parsed.string("output") {
            Some("json") => Format::Json,
            Some("markdown") => Format::Markdown,
            _ => Format::Text,
        })
    });
    terminal.end_progress();
    std::process::exit(code);
}
