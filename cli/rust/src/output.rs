//! Where the CLI writes. Mirrors `../../nodejs/src/output.ts`.
//!
//! The stream split is the contract: *stdout is the machine surface* — under `-o json` it
//! carries the payload and nothing else, so `line` (prose) goes silent there — and *stderr
//! is the human surface in both formats*, so `err_line` always writes. Colour is decided per
//! stream. Not twinned yet: the transient progress line, `document` and the prompt, which
//! no command here uses.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{ErrorKind, IsTerminal, Write};

use serde_json::Value;

use crate::color_precedence::decide_color;

/// Output encodings the CLI can produce. `yaml` is deliberately absent, as in Node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Text,
    Json,
}

/// The values `-o` accepts, in Node's order.
pub const OUTPUT_FORMATS: [&str; 2] = ["text", "json"];

impl OutputFormat {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Self::Text),
            "json" => Some(Self::Json),
            _ => None,
        }
    }
}

/// A colour palette bound to ONE stream.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    colored: bool,
}

impl Palette {
    pub const PLAIN: Palette = Palette { colored: false };

    fn wrap(&self, code: &str, text: &str) -> String {
        if self.colored {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    pub fn ok(&self, text: &str) -> String {
        self.wrap("32", text)
    }

    pub fn warn(&self, text: &str) -> String {
        self.wrap("33", text)
    }

    pub fn error(&self, text: &str) -> String {
        self.wrap("31", text)
    }

    pub fn dim(&self, text: &str) -> String {
        self.wrap("2", text)
    }
}

/// The single seam every CLI-owned write goes through; streams and environment are
/// constructor arguments so a test builds one over recorders.
pub struct Output {
    pub format: OutputFormat,
    /// Always plain under `-o json`: structured output never carries escapes.
    pub stdout: Palette,
    /// Keeps its colour under `-o json`, since stderr stays the human surface.
    pub stderr: Palette,
    out: RefCell<Box<dyn Write>>,
    err: RefCell<Box<dyn Write>>,
}

impl Output {
    pub fn new(
        format: OutputFormat,
        env: &HashMap<String, String>,
        stdout_is_tty: bool,
        stderr_is_tty: bool,
        out: Box<dyn Write>,
        err: Box<dyn Write>,
    ) -> Self {
        let palette = |is_tty: bool| Palette { colored: decide_color(env, is_tty) };
        Self {
            format,
            stdout: if format == OutputFormat::Text { palette(stdout_is_tty) } else { Palette::PLAIN },
            stderr: palette(stderr_is_tty),
            out: RefCell::new(out),
            err: RefCell::new(err),
        }
    }

    /// Over this process's descriptors and environment.
    pub fn process(format: OutputFormat) -> Self {
        let env = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect();
        Self::new(
            format,
            &env,
            std::io::stdout().is_terminal(),
            std::io::stderr().is_terminal(),
            Box::new(std::io::stdout()),
            Box::new(std::io::stderr()),
        )
    }

    /// Human-readable line on stdout; suppressed under `-o json`.
    pub fn line(&self, text: &str) -> std::io::Result<()> {
        if self.format != OutputFormat::Text {
            return Ok(());
        }
        write_all(&self.out, format!("{text}\n").as_bytes())
    }

    /// Human-readable line on stderr, written in both formats.
    pub fn err_line(&self, text: &str) -> std::io::Result<()> {
        write_all(&self.err, format!("{text}\n").as_bytes())
    }

    /// A command's structured result envelope: silent under `text`, plain JSON indented by
    /// two spaces under `json`.
    pub fn emit(&self, payload: &Value) -> std::io::Result<()> {
        if self.format != OutputFormat::Json {
            return Ok(());
        }
        let text = serde_json::to_string_pretty(payload).expect("a JSON value serializes");
        write_all(&self.out, format!("{text}\n").as_bytes())
    }
}

/// A reader that closed its end (`telo … | head`) has taken everything it wants, so that
/// ends the write without failing it; any other failure is returned.
fn write_all(stream: &RefCell<Box<dyn Write>>, bytes: &[u8]) -> std::io::Result<()> {
    let mut stream = stream.borrow_mut();
    match stream.write_all(bytes).and_then(|()| stream.flush()) {
        Err(err) if err.kind() == ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

/// Write a document to stdout verbatim, with no framing.
pub fn raw(content: &str) -> std::io::Result<()> {
    let mut stdout = std::io::stdout().lock();
    match stdout.write_all(content.as_bytes()).and_then(|()| stdout.flush()) {
        Err(err) if err.kind() == ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

/// One line of human text on stderr.
pub fn err_line(text: &str) {
    eprintln!("{text}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    #[derive(Clone, Default)]
    struct Recorder(Rc<RefCell<Vec<u8>>>);

    impl Write for Recorder {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn recorded(format: OutputFormat, env: &[(&str, &str)]) -> (Output, Recorder, Recorder) {
        let env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let (out, err) = (Recorder::default(), Recorder::default());
        let output = Output::new(format, &env, true, true, Box::new(out.clone()), Box::new(err.clone()));
        (output, out, err)
    }

    fn text(recorder: &Recorder) -> String {
        String::from_utf8(recorder.0.borrow().clone()).unwrap()
    }

    #[test]
    fn json_keeps_stdout_for_the_payload_and_stderr_for_prose() {
        let (output, out, err) = recorded(OutputFormat::Json, &[]);
        output.line("prose").unwrap();
        output.err_line("reason").unwrap();
        output.emit(&serde_json::json!({ "ok": true, "items": [] })).unwrap();
        assert_eq!(text(&out), "{\n  \"ok\": true,\n  \"items\": []\n}\n");
        assert!(text(&err).starts_with("reason"));
        assert_eq!(output.stdout.error("x"), "x");
        assert_eq!(output.stderr.error("x"), "\x1b[31mx\x1b[0m");
    }

    #[test]
    fn text_writes_prose_to_stdout_and_emits_nothing_and_no_color_wins() {
        let (output, out, _) = recorded(OutputFormat::Text, &[("NO_COLOR", "1")]);
        output.line("prose").unwrap();
        output.emit(&serde_json::json!({ "ok": true })).unwrap();
        assert_eq!(text(&out), "prose\n");
        assert_eq!(output.stdout.ok("x"), "x");
        assert_eq!(output.stderr.warn("x"), "x");
    }
}
