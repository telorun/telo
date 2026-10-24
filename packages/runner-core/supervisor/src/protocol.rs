//! The supervisor protocol, generation 1: every message, its validation and the
//! output frame. Normative text: `packages/runner-core/specs/supervisor-protocol.md`.
//! No Node twin — the crate runs where no runtime is (see the crate README); the
//! runner's half is `packages/runner-core/src/supervisor/supervisor-protocol.ts`.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const GENERATION: u64 = 1;
pub const PATH: &str = "/v1/supervisor";

/// The largest `cols` / `rows` a message may carry.
pub const MAX_DIMENSION: u64 = 10_000;
/// The largest `graceMs` a `stop` may carry (one hour).
pub const MAX_GRACE_MS: u64 = 3_600_000;

pub mod close_code {
    /// A malformed message, or a message out of order.
    pub const PROTOCOL_ERROR: u16 = 4400;
    pub const TOKEN_MISSING: u16 = 4401;
    pub const TOKEN_INVALID: u16 = 4403;
    /// No `hello` arrived within the hello window.
    pub const HELLO_TIMEOUT: u16 = 4408;
    /// Another runner connection said `hello`.
    pub const SUPERSEDED: u16 = 4409;
    pub const GENERATION_MISMATCH: u16 = 4426;
    /// The runner read too slowly to keep up with the output.
    pub const BACKLOGGED: u16 = 4429;
}

/// The byte channel's stream tags (`packages/runner-core/src/contract.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputStream {
    Tty,
    Stdout,
    Stderr,
}

impl OutputStream {
    pub fn code(self) -> u8 {
        match self {
            OutputStream::Tty => 0,
            OutputStream::Stdout => 1,
            OutputStream::Stderr => 2,
        }
    }

    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(OutputStream::Tty),
            1 => Some(OutputStream::Stdout),
            2 => Some(OutputStream::Stderr),
            _ => None,
        }
    }
}

pub const FRAME_HEADER_BYTES: usize = 5;

/// `[seq:4 BE][stream:1][payload]`.
pub fn encode_output_frame(seq: u32, stream: OutputStream, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&seq.to_be_bytes());
    frame.push(stream.code());
    frame.extend_from_slice(payload);
    frame
}

pub fn decode_output_frame(frame: &[u8]) -> Result<(u32, OutputStream, &[u8]), ProtocolError> {
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(ProtocolError::new(format!(
            "an output frame is at least {FRAME_HEADER_BYTES} bytes, got {}",
            frame.len()
        )));
    }
    let seq = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
    if seq == 0 {
        return Err(ProtocolError::new("an output frame's seq starts at 1".into()));
    }
    let stream = OutputStream::from_code(frame[4])
        .ok_or_else(|| ProtocolError::new(format!("unknown stream code {}", frame[4])))?;
    Ok((seq, stream, &frame[FRAME_HEADER_BYTES..]))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IoMode {
    Tty,
    Streams,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRequest {
    pub run_id: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub io: IoMode,
    /// `(cols, rows)`; read only under `tty`.
    pub size: Option<(u16, u16)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunnerMessage {
    Hello { last_seq: u32 },
    Run(RunRequest),
    Stop { run_id: String, grace_ms: u64 },
    Resize { cols: u16, rows: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupervisorState {
    Idle,
    Running,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalCode {
    RunActive,
    NoRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum SupervisorMessage {
    Hello {
        generation: u64,
        instance: String,
        state: SupervisorState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
    },
    Started {
        run_id: String,
    },
    Exited {
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    Failed {
        run_id: String,
        reason: String,
    },
    Refused {
        run_id: String,
        code: RefusalCode,
    },
}

impl SupervisorMessage {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("a supervisor message always serializes")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    pub message: String,
}

impl ProtocolError {
    fn new(message: String) -> Self {
        ProtocolError { message }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Why a runner's text frame is refused, mapped to the close code it earns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessageRefusal {
    /// A `hello` of another generation: judged before any other field, since a
    /// later generation may carry fields this one does not know.
    GenerationMismatch(u64),
    Invalid(ProtocolError),
}

impl MessageRefusal {
    pub fn close_code(&self) -> u16 {
        match self {
            MessageRefusal::GenerationMismatch(_) => close_code::GENERATION_MISMATCH,
            MessageRefusal::Invalid(_) => close_code::PROTOCOL_ERROR,
        }
    }

    pub fn reason(&self) -> String {
        match self {
            MessageRefusal::GenerationMismatch(theirs) => {
                format!("runner speaks generation {theirs}, supervisor speaks {GENERATION}")
            }
            MessageRefusal::Invalid(error) => error.message.clone(),
        }
    }
}

fn invalid(message: String) -> MessageRefusal {
    MessageRefusal::Invalid(ProtocolError::new(message))
}

pub fn parse_runner_message(text: &str) -> Result<RunnerMessage, MessageRefusal> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| invalid(format!("not JSON: {error}")))?;
    let Value::Object(object) = value else {
        return Err(invalid("a control message is a JSON object".into()));
    };
    let kind = match object.get("type") {
        Some(Value::String(kind)) => kind.clone(),
        Some(_) => return Err(invalid("'type' must be a string".into())),
        None => return Err(invalid("a control message carries 'type'".into())),
    };
    let mut fields = Fields { kind: kind.clone(), object };
    let message = match kind.as_str() {
        "hello" => {
            let generation = fields.integer("generation", u64::MAX)?;
            if generation != GENERATION {
                return Err(MessageRefusal::GenerationMismatch(generation));
            }
            let last_seq = fields.integer("lastSeq", u32::MAX as u64)? as u32;
            RunnerMessage::Hello { last_seq }
        }
        "run" => {
            let run_id = fields.run_id()?;
            let argv = fields.argv()?;
            let env = fields.env()?;
            let cwd = fields.string("cwd")?;
            if cwd.is_empty() || cwd.contains('\0') {
                return Err(invalid("'run.cwd' must be a non-empty path".into()));
            }
            let io = match fields.string("io")?.as_str() {
                "tty" => IoMode::Tty,
                "streams" => IoMode::Streams,
                other => {
                    return Err(invalid(format!("'run.io' must be \"tty\" or \"streams\", got {other:?}")))
                }
            };
            let cols = fields.optional_dimension("cols")?;
            let rows = fields.optional_dimension("rows")?;
            let size = match (cols, rows) {
                (Some(cols), Some(rows)) => Some((cols, rows)),
                (None, None) => None,
                _ => return Err(invalid("'run.cols' and 'run.rows' come together".into())),
            };
            RunnerMessage::Run(RunRequest { run_id, argv, env, cwd, io, size })
        }
        "stop" => {
            let run_id = fields.run_id()?;
            let grace_ms = fields.integer("graceMs", MAX_GRACE_MS)?;
            RunnerMessage::Stop { run_id, grace_ms }
        }
        "resize" => {
            let cols = fields.dimension("cols")?;
            let rows = fields.dimension("rows")?;
            RunnerMessage::Resize { cols, rows }
        }
        other => return Err(invalid(format!("unknown message type {other:?}"))),
    };
    fields.finish()?;
    Ok(message)
}

struct Fields {
    kind: String,
    object: Map<String, Value>,
}

impl Fields {
    fn take(&mut self, name: &str) -> Option<Value> {
        self.object.remove(name)
    }

    fn required(&mut self, name: &str) -> Result<Value, MessageRefusal> {
        self.take(name)
            .ok_or_else(|| invalid(format!("'{}' carries '{name}'", self.kind)))
    }

    fn string(&mut self, name: &str) -> Result<String, MessageRefusal> {
        match self.required(name)? {
            Value::String(text) => Ok(text),
            _ => Err(invalid(format!("'{}.{name}' must be a string", self.kind))),
        }
    }

    fn integer(&mut self, name: &str, max: u64) -> Result<u64, MessageRefusal> {
        let value = self.required(name)?;
        integer_in(&value, max)
            .ok_or_else(|| invalid(format!("'{}.{name}' must be an integer from 0 to {max}", self.kind)))
    }

    fn dimension(&mut self, name: &str) -> Result<u16, MessageRefusal> {
        let value = self.required(name)?;
        dimension_of(&value).ok_or_else(|| {
            invalid(format!("'{}.{name}' must be an integer from 1 to {MAX_DIMENSION}", self.kind))
        })
    }

    fn optional_dimension(&mut self, name: &str) -> Result<Option<u16>, MessageRefusal> {
        match self.take(name) {
            None => Ok(None),
            Some(value) => dimension_of(&value).map(Some).ok_or_else(|| {
                invalid(format!("'{}.{name}' must be an integer from 1 to {MAX_DIMENSION}", self.kind))
            }),
        }
    }

    fn run_id(&mut self) -> Result<String, MessageRefusal> {
        let run_id = self.string("runId")?;
        if run_id.is_empty() {
            return Err(invalid(format!("'{}.runId' must not be empty", self.kind)));
        }
        Ok(run_id)
    }

    fn argv(&mut self) -> Result<Vec<String>, MessageRefusal> {
        let Value::Array(items) = self.required("argv")? else {
            return Err(invalid("'run.argv' must be an array of strings".into()));
        };
        if items.is_empty() {
            return Err(invalid("'run.argv' names at least the program".into()));
        }
        let mut argv = Vec::with_capacity(items.len());
        for item in items {
            match item {
                Value::String(arg) if !arg.contains('\0') => argv.push(arg),
                _ => return Err(invalid("'run.argv' must be an array of strings without NUL".into())),
            }
        }
        if argv[0].is_empty() {
            return Err(invalid("'run.argv[0]' must name a program".into()));
        }
        Ok(argv)
    }

    fn env(&mut self) -> Result<BTreeMap<String, String>, MessageRefusal> {
        let Value::Object(entries) = self.required("env")? else {
            return Err(invalid("'run.env' must be an object of strings".into()));
        };
        let mut env = BTreeMap::new();
        for (name, value) in entries {
            if name.is_empty() || name.contains('=') || name.contains('\0') {
                return Err(invalid(format!("'run.env' holds an invalid variable name {name:?}")));
            }
            match value {
                Value::String(text) if !text.contains('\0') => {
                    env.insert(name, text);
                }
                _ => return Err(invalid(format!("'run.env.{name}' must be a string without NUL"))),
            }
        }
        Ok(env)
    }

    fn finish(self) -> Result<(), MessageRefusal> {
        let unknown: Vec<&String> = self.object.keys().filter(|key| *key != "type").collect();
        match unknown.first() {
            None => Ok(()),
            Some(key) => Err(invalid(format!(
                "'{}' has no field '{key}' in generation {GENERATION}",
                self.kind
            ))),
        }
    }
}

fn integer_in(value: &Value, max: u64) -> Option<u64> {
    value.as_u64().filter(|n| *n <= max)
}

fn dimension_of(value: &Value) -> Option<u16> {
    integer_in(value, MAX_DIMENSION)
        .filter(|n| *n >= 1)
        .map(|n| n as u16)
}
