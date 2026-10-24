//! Runs `vectors/` against the protocol module and against the built
//! `supervisor` executable. The same vectors are run by runner-core's
//! `supervisor-vectors.test.ts`. No Node twin — the crate runs where no runtime
//! is (see the crate README).
#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use telo_runner_supervisor::protocol::{
    decode_output_frame, encode_output_frame, parse_runner_message, OutputStream, SupervisorMessage,
};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const TOKEN: &str = "vector-token";
const DEFAULT_WITHIN: Duration = Duration::from_secs(5);

fn vectors(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn runner_messages() {
    let set = vectors("messages.json");
    for case in set["runner"]["valid"].as_array().unwrap() {
        let text = case["message"].to_string();
        if let Err(refusal) = parse_runner_message(&text) {
            panic!("{}: refused: {}", case["name"], refusal.reason());
        }
    }
    for case in set["runner"]["invalid"].as_array().unwrap() {
        match parse_runner_message(case["text"].as_str().unwrap()) {
            Ok(message) => panic!("{}: accepted as {message:?}", case["name"]),
            Err(refusal) => assert_eq!(
                u64::from(refusal.close_code()),
                case["close"].as_u64().unwrap(),
                "{}: {}",
                case["name"],
                refusal.reason()
            ),
        }
    }
}

#[test]
fn supervisor_messages() {
    let set = vectors("messages.json");
    for case in set["supervisor"]["valid"].as_array().unwrap() {
        let message: SupervisorMessage = serde_json::from_value(case["message"].clone())
            .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
        let encoded: Value = serde_json::from_str(&message.encode()).unwrap();
        assert_eq!(encoded, case["message"], "{}", case["name"]);
    }
}

#[test]
fn output_frames() {
    let set = vectors("output-frames.json");
    for case in set["valid"].as_array().unwrap() {
        let stream = stream_named(case["stream"].as_str().unwrap());
        let payload = from_hex(case["payloadHex"].as_str().unwrap());
        let frame = encode_output_frame(case["seq"].as_u64().unwrap() as u32, stream, &payload);
        assert_eq!(to_hex(&frame), case["frameHex"].as_str().unwrap(), "{}", case["name"]);
    }
    for case in set["invalid"].as_array().unwrap() {
        let frame = from_hex(case["frameHex"].as_str().unwrap());
        assert!(decode_output_frame(&frame).is_err(), "{}: decoded", case["name"]);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn exchanges() {
    let set = vectors("exchanges.json");
    for exchange in set["exchanges"].as_array().unwrap() {
        let name = exchange["name"].as_str().unwrap();
        let mut supervisor = RunningSupervisor::start(&set["workspace"]);
        if let Err(failure) = run_exchange(&mut supervisor, exchange["steps"].as_array().unwrap()).await {
            panic!("exchange {name:?}: {failure}\n--- supervisor log ---\n{}", supervisor.log());
        }
    }
}

struct RunningSupervisor {
    child: Child,
    address: String,
    workspace: PathBuf,
    log: mpsc::Receiver<String>,
    seen: std::cell::RefCell<Vec<String>>,
}

impl RunningSupervisor {
    fn start(files: &Value) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let workspace = std::env::temp_dir().join(format!(
            "telo-supervisor-vectors-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        for (path, content) in files.as_object().unwrap() {
            let file = workspace.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, content.as_str().unwrap()).unwrap();
        }
        let mut child = Command::new(env!("CARGO_BIN_EXE_supervisor"))
            .arg("--workspace")
            .arg(&workspace)
            .env("TELO_SUPERVISOR_LISTEN", "127.0.0.1:0")
            .env("TELO_SUPERVISOR_TOKEN", TOKEN)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the supervisor starts");
        let stderr = child.stderr.take().unwrap();
        let (lines, log) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if lines.send(line).is_err() {
                    return;
                }
            }
        });
        let mut seen = Vec::new();
        let deadline = Instant::now() + DEFAULT_WITHIN;
        let address = loop {
            let line = log
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("the supervisor never said where it listens: {seen:?}"));
            let address = line.strip_prefix("supervisor info: listening on ").map(str::to_string);
            seen.push(line);
            if let Some(address) = address {
                break address;
            }
        };
        RunningSupervisor { child, address, workspace, log, seen: std::cell::RefCell::new(seen) }
    }

    fn log(&self) -> String {
        let mut seen = self.seen.borrow_mut();
        seen.extend(self.log.try_iter());
        seen.join("\n")
    }
}

impl Drop for RunningSupervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.workspace);
    }
}

type Socket = WebSocketStream<TcpStream>;

#[derive(Debug)]
enum Received {
    Text(Value),
    Frame(u32, OutputStream, Vec<u8>),
    Closed(Option<u16>),
}

struct Connection {
    socket: Option<Socket>,
    output: HashMap<&'static str, Vec<(u32, Vec<u8>)>>,
    last_frame_seq: Option<u32>,
}

impl Connection {
    async fn receive(&mut self, within: Duration) -> Result<Received, String> {
        let Some(socket) = self.socket.as_mut() else {
            return Ok(Received::Closed(None));
        };
        loop {
            let next = tokio::time::timeout(within, socket.next())
                .await
                .map_err(|_| format!("nothing arrived within {} ms", within.as_millis()))?;
            match next {
                None => {
                    self.socket = None;
                    return Ok(Received::Closed(None));
                }
                Some(Err(error)) => {
                    self.socket = None;
                    return Err(format!("the connection failed: {error}"));
                }
                Some(Ok(Message::Text(text))) => {
                    let value = serde_json::from_str(&text).map_err(|error| format!("not JSON: {error}"))?;
                    return Ok(Received::Text(value));
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let (seq, stream, payload) =
                        decode_output_frame(&bytes).map_err(|error| format!("bad frame: {error}"))?;
                    if let Some(previous) = self.last_frame_seq {
                        if seq != previous + 1 {
                            return Err(format!("frame seq {seq} after {previous}"));
                        }
                    }
                    self.last_frame_seq = Some(seq);
                    return Ok(Received::Frame(seq, stream, payload.to_vec()));
                }
                Some(Ok(Message::Close(frame))) => {
                    self.socket = None;
                    return Ok(Received::Closed(frame.map(|frame| u16::from(frame.code))));
                }
                Some(Ok(_)) => continue,
            }
        }
    }
}

async fn run_exchange(supervisor: &mut RunningSupervisor, steps: &[Value]) -> Result<(), String> {
    let mut connections: HashMap<String, Connection> = HashMap::new();
    let mut recorded: HashMap<String, u32> = HashMap::new();
    for (index, step) in steps.iter().enumerate() {
        let on = step["on"].as_str().unwrap_or("main").to_string();
        let within = step["withinMs"].as_u64().map(Duration::from_millis).unwrap_or(DEFAULT_WITHIN);
        let fail = |message: String| format!("step {index} ({step}): {message}");
        if let Some(name) = step["connect"].as_str() {
            let socket = connect(&supervisor.address, step["token"].as_str().unwrap()).await.map_err(fail)?;
            connections.insert(
                name.to_string(),
                Connection { socket: Some(socket), output: HashMap::new(), last_frame_seq: None },
            );
            continue;
        }
        if let Some(ms) = step["wait"].as_u64() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            continue;
        }
        if let Some(signal) = step["signalSupervisor"].as_str() {
            let signal = match signal {
                "SIGTERM" => libc::SIGTERM,
                "SIGINT" => libc::SIGINT,
                other => return Err(fail(format!("unknown signal {other}"))),
            };
            if unsafe { libc::kill(supervisor.child.id() as i32, signal) } == -1 {
                return Err(fail(std::io::Error::last_os_error().to_string()));
            }
            continue;
        }
        if let Some(code) = step["expectSupervisorExit"].as_i64() {
            let deadline = Instant::now() + within;
            let status = loop {
                if let Some(status) = supervisor.child.try_wait().map_err(|error| fail(error.to_string()))? {
                    break status;
                }
                if Instant::now() > deadline {
                    return Err(fail("the supervisor is still running".into()));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            if status.code().map(i64::from) != Some(code) {
                return Err(fail(format!("the supervisor exited {status}")));
            }
            continue;
        }
        if let Some(name) = step["close"].as_str() {
            let connection = connections.get_mut(name).ok_or_else(|| fail(format!("no connection {name}")))?;
            if let Some(mut socket) = connection.socket.take() {
                socket.close(None).await.map_err(|error| fail(error.to_string()))?;
            }
            continue;
        }
        let connection = connections.get_mut(&on).ok_or_else(|| fail(format!("no connection {on}")))?;
        if let Some(message) = step.get("send") {
            let text = substitute(message, &recorded).to_string();
            send(connection, Message::Text(text.into())).await.map_err(fail)?;
        } else if let Some(text) = step["sendText"].as_str() {
            send(connection, Message::Text(text.to_string().into())).await.map_err(fail)?;
        } else if let Some(text) = step["sendStdin"].as_str() {
            send(connection, Message::Binary(text.as_bytes().to_vec().into())).await.map_err(fail)?;
        } else if let Some(expected) = step.get("expect") {
            let mut actual = next_text(connection, within).await.map_err(fail)?;
            for key in step["ignore"].as_array().into_iter().flatten() {
                let key = key.as_str().unwrap();
                if actual.as_object_mut().and_then(|object| object.remove(key)).is_none() {
                    return Err(fail(format!("{actual} carries no {key}")));
                }
            }
            if actual != *expected {
                return Err(fail(format!("got {actual}")));
            }
        } else if let Some(output) = step.get("expectOutput") {
            let label = output["stream"].as_str().unwrap();
            let stream = stream_named(label);
            let deadline = Instant::now() + within;
            loop {
                let frames = connection.output.entry(stream_label(stream)).or_default();
                let text: Vec<u8> = frames.iter().flat_map(|(_, bytes)| bytes.clone()).collect();
                let text = String::from_utf8_lossy(&text).to_string();
                let satisfied = match (output["text"].as_str(), output["contains"].as_str()) {
                    (Some(exact), _) => text == exact,
                    (None, Some(part)) => text.contains(part),
                    _ => return Err(fail("expectOutput names text or contains".into())),
                };
                if satisfied {
                    if let Some(first) = output.get("firstSeq") {
                        let expected = seq_of(first, &recorded).map_err(fail)?;
                        if frames[0].0 != expected {
                            return Err(fail(format!("first frame seq {} is not {expected}", frames[0].0)));
                        }
                    }
                    if let Some(name) = step["record"].as_str() {
                        recorded.insert(name.to_string(), frames.last().unwrap().0);
                    }
                    frames.clear();
                    break;
                }
                if let Some(exact) = output["text"].as_str() {
                    if !exact.starts_with(&text) {
                        return Err(fail(format!("{label} reads {text:?}")));
                    }
                }
                let left = deadline.saturating_duration_since(Instant::now());
                match connection.receive(left).await.map_err(fail)? {
                    Received::Frame(seq, stream, bytes) => {
                        connection.output.entry(stream_label(stream)).or_default().push((seq, bytes))
                    }
                    other => return Err(fail(format!("{label} reads {text:?}, then {other:?} arrived"))),
                }
            }
        } else if let Some(code) = step["expectClose"].as_u64() {
            loop {
                match connection.receive(within).await.map_err(fail)? {
                    Received::Closed(actual) => {
                        if actual.map(u64::from) != Some(code) {
                            return Err(fail(format!("closed with {actual:?}")));
                        }
                        break;
                    }
                    _ => continue,
                }
            }
        } else if let Some(ms) = step["expectSilence"].as_u64() {
            match connection.receive(Duration::from_millis(ms)).await {
                Err(_) => {}
                Ok(received) => return Err(fail(format!("{received:?} arrived"))),
            }
        } else {
            return Err(fail("unknown step".into()));
        }
    }
    Ok(())
}

async fn next_text(connection: &mut Connection, within: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + within;
    loop {
        match connection.receive(deadline.saturating_duration_since(Instant::now())).await? {
            Received::Text(value) => return Ok(value),
            Received::Frame(seq, stream, bytes) => {
                connection.output.entry(stream_label(stream)).or_default().push((seq, bytes))
            }
            Received::Closed(code) => return Err(format!("closed with {code:?}")),
        }
    }
}

async fn send(connection: &mut Connection, message: Message) -> Result<(), String> {
    let socket = connection.socket.as_mut().ok_or("the connection is closed")?;
    socket.send(message).await.map_err(|error| error.to_string())
}

async fn connect(address: &str, token: &str) -> Result<Socket, String> {
    let mut request = format!("ws://{address}/v1/supervisor")
        .into_client_request()
        .map_err(|error| error.to_string())?;
    let header = match token {
        "valid" => Some(format!("Bearer {TOKEN}")),
        "wrong" => Some(format!("Bearer {TOKEN}-not")),
        "none" => None,
        other => return Err(format!("unknown token {other}")),
    };
    if let Some(header) = header {
        request.headers_mut().insert("authorization", HeaderValue::from_str(&header).unwrap());
    }
    let stream = TcpStream::connect(address).await.map_err(|error| error.to_string())?;
    let (socket, _) = tokio_tungstenite::client_async(request, stream).await.map_err(|error| error.to_string())?;
    Ok(socket)
}

fn substitute(value: &Value, recorded: &HashMap<String, u32>) -> Value {
    match value {
        Value::String(text) if text.starts_with('$') => recorded
            .get(&text[1..])
            .map(|seq| Value::from(*seq))
            .unwrap_or_else(|| panic!("nothing recorded as {text}")),
        Value::Object(object) => {
            Value::Object(object.iter().map(|(key, value)| (key.clone(), substitute(value, recorded))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| substitute(item, recorded)).collect()),
        other => other.clone(),
    }
}

fn seq_of(value: &Value, recorded: &HashMap<String, u32>) -> Result<u32, String> {
    if let Some(seq) = value.as_u64() {
        return Ok(seq as u32);
    }
    let text = value.as_str().ok_or("firstSeq is a number or \"$label+1\"")?;
    let label = text.strip_prefix('$').and_then(|rest| rest.strip_suffix("+1")).ok_or("firstSeq is \"$label+1\"")?;
    recorded.get(label).map(|seq| seq + 1).ok_or_else(|| format!("nothing recorded as {label}"))
}

fn stream_named(name: &str) -> OutputStream {
    match name {
        "tty" => OutputStream::Tty,
        "stdout" => OutputStream::Stdout,
        "stderr" => OutputStream::Stderr,
        other => panic!("unknown stream {other}"),
    }
}

fn stream_label(stream: OutputStream) -> &'static str {
    match stream {
        OutputStream::Tty => "tty",
        OutputStream::Stdout => "stdout",
        OutputStream::Stderr => "stderr",
    }
}

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
