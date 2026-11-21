//! `cargo run -p telo-kernel --example analyze_only -- <entry manifest>`: loads the entry with
//! `analyze_only` and prints the refusal, if any, as one JSON object on stdout, exiting 1:
//! `{ code, message, carried: [{ code?, file?, message, writtenAt? }] }` — each carried finding
//! under the code it is raised as, `file` its `data.filePath` (absent: the entry) and
//! `writtenAt` its `data.writtenAt`. A load nothing refuses prints nothing and exits 0.
//!
//! It has no Node twin: it exists so the rust-parity sweep's `load` dimension can ask this
//! kernel what it refuses a load with, as a sweep-owned script asks the Node kernel through
//! its `analyzeOnly` load option. It is no CLI command and is never published.

use std::process::ExitCode;

use serde_json::{json, Map, Value};
use telo_kernel::{Kernel, LoadOptions};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(entry), None) = (args.next(), args.next()) else {
        eprintln!("usage: analyze_only <entry manifest>");
        return ExitCode::from(2);
    };
    let mut kernel = Kernel::new();
    let Err(error) = kernel.load_with(&entry, LoadOptions { analyze_only: true }) else {
        return ExitCode::SUCCESS;
    };
    let carried: Vec<Value> = error
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let mut finding = Map::new();
            if let Some(code) = &diagnostic.code {
                finding.insert("code".into(), json!(code));
            }
            let data = diagnostic.data.as_ref();
            if let Some(file) = data.and_then(|data| data.file_path.as_ref()) {
                finding.insert("file".into(), json!(file));
            }
            finding.insert("message".into(), json!(diagnostic.message));
            if let Some(written) = data.and_then(|data| data.written_at.as_ref()) {
                finding.insert("writtenAt".into(), json!(written));
            }
            Value::Object(finding)
        })
        .collect();
    println!("{}", json!({ "code": error.code, "message": error.message, "carried": carried }));
    ExitCode::from(1)
}
