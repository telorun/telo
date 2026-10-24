//! The supervisor's one state: the live run, the run that ended last, the
//! output ring and the one runner connection. Every rule of the protocol's
//! idempotency and ordering is decided here, under one lock. No Node twin — the
//! crate runs where no runtime is (see the crate README).

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, Notify};

use crate::output_ring::{OutputRing, RING_BYTES};
use crate::protocol::{
    close_code, OutputStream, RefusalCode, RunRequest, SupervisorMessage, SupervisorState, GENERATION,
};
use crate::run_process::{self, ExitOutcome};
use crate::supervisor_log;

/// How long a run's output may stay open after its process ended before the
/// run is reported ended anyway (a process that left the group holds it).
pub const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(2);
/// What a connection may have queued and unsent before it is dropped as
/// backlogged; the runner reconnects and is replayed from the ring.
pub const MAX_PENDING_BYTES: usize = 4 * RING_BYTES;
const READ_CHUNK: usize = 16 * 1024;

pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
}

impl Outgoing {
    fn len(&self) -> usize {
        match self {
            Outgoing::Text(text) => text.len(),
            Outgoing::Binary(bytes) => bytes.len(),
        }
    }
}

/// The handles one connection's writer is driven through.
pub struct ConnectionHandles {
    pub outgoing: mpsc::UnboundedSender<Outgoing>,
    /// The close to send; with `flush`, after what is already queued.
    pub close: oneshot::Sender<ConnectionClose>,
    pub pending: Arc<AtomicUsize>,
}

pub struct ConnectionClose {
    pub code: u16,
    pub reason: String,
    pub flush: bool,
}

struct Connection {
    id: u64,
    handles: ConnectionHandles,
}

impl Connection {
    /// `false` when the connection is too far behind to take more.
    fn offer(&self, message: Outgoing) -> bool {
        let len = message.len();
        if self.handles.pending.load(Ordering::Acquire) + len > MAX_PENDING_BYTES {
            return false;
        }
        self.handles.pending.fetch_add(len, Ordering::AcqRel);
        // A writer that is gone has a reader that already ended the connection.
        self.handles.outgoing.send(message).is_ok()
    }

    fn close(self, code: u16, reason: String) {
        self.close_with(ConnectionClose { code, reason, flush: false });
    }

    fn close_with(self, close: ConnectionClose) {
        // Refused only when the writer already ended, which closed the socket.
        let _ = self.handles.close.send(close);
    }
}

#[derive(Clone)]
enum Ending {
    Exited(ExitOutcome),
    Failed(String),
}

struct LiveRun {
    run_id: String,
    epoch: u64,
    pid: i32,
    stdin: std_mpsc::Sender<Vec<u8>>,
    pty_master: Option<OwnedFd>,
    open_streams: usize,
    exit: Option<ExitOutcome>,
    stopping: bool,
}

struct State {
    live: Option<LiveRun>,
    last_ended: Option<(String, Ending)>,
    ring: OutputRing,
    connection: Option<Connection>,
    next_epoch: u64,
    shutting_down: bool,
}

pub struct Supervisor {
    state: Mutex<State>,
    /// Held across a spawn and across reaping: the standard library waits on a
    /// child whose exec failed, and a concurrent `waitpid(-1)` would take it.
    spawn_lock: Mutex<()>,
    workspace: PathBuf,
    instance: String,
    /// Notified when the live run ends during shutdown.
    pub idle: Notify,
}

impl Supervisor {
    pub fn new(workspace: PathBuf, instance: String) -> Self {
        Supervisor {
            state: Mutex::new(State {
                live: None,
                last_ended: None,
                ring: OutputRing::new(RING_BYTES),
                connection: None,
                next_epoch: 1,
                shutting_down: false,
            }),
            spawn_lock: Mutex::new(()),
            workspace,
            instance,
            idle: Notify::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Makes `id` THE connection: answers `hello`, replays every retained frame
    /// above `last_seq`, then streams live — in one step, so nothing is lost or
    /// sent twice between the replay and the live output.
    pub fn attach(&self, id: u64, handles: ConnectionHandles, last_seq: u32) {
        let mut state = self.lock();
        if let Some(previous) = state.connection.take() {
            supervisor_log::info(&format!("connection {} superseded by connection {id}", previous.id));
            previous.close(close_code::SUPERSEDED, "another runner connection said hello".into());
        }
        let hello = SupervisorMessage::Hello {
            generation: GENERATION,
            instance: self.instance.clone(),
            state: if state.live.is_some() { SupervisorState::Running } else { SupervisorState::Idle },
            run_id: state.live.as_ref().map(|live| live.run_id.clone()),
        };
        let connection = Connection { id, handles };
        let mut accepted = connection.offer(Outgoing::Text(hello.encode()));
        for frame in state.ring.after(last_seq) {
            if !accepted {
                break;
            }
            accepted = connection.offer(Outgoing::Binary(frame.clone()));
        }
        if accepted {
            state.connection = Some(connection);
        } else {
            supervisor_log::warn(&format!("connection {id} could not take its replay"));
            connection.close(close_code::BACKLOGGED, "the replay exceeded the connection's queue".into());
        }
    }

    pub fn detach(&self, id: u64) {
        let mut state = self.lock();
        if state.connection.as_ref().is_some_and(|connection| connection.id == id) {
            state.connection = None;
        }
    }

    pub fn close_connection(&self, id: u64, code: u16, reason: String) {
        let mut state = self.lock();
        if state.connection.as_ref().is_some_and(|connection| connection.id == id) {
            if let Some(connection) = state.connection.take() {
                connection.close(code, reason);
            }
        }
    }

    pub fn handle_run(self: &Arc<Self>, request: RunRequest) {
        let mut state = self.lock();
        if let Some(live) = &state.live {
            let message = if live.run_id == request.run_id {
                SupervisorMessage::Started { run_id: request.run_id }
            } else {
                SupervisorMessage::Refused { run_id: request.run_id, code: RefusalCode::RunActive }
            };
            send(&mut state, message);
            return;
        }
        if let Some((run_id, ending)) = &state.last_ended {
            if *run_id == request.run_id {
                let message = ending_message(run_id, ending);
                send(&mut state, message);
                return;
            }
        }
        if state.shutting_down {
            let reason = "the supervisor is shutting down".to_string();
            send(&mut state, SupervisorMessage::Failed { run_id: request.run_id, reason });
            return;
        }
        let spawned = {
            let _spawning = self.spawn_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            run_process::spawn(&request, &self.workspace)
        };
        let run = match spawned {
            Ok(run) => run,
            Err(error) => {
                let reason = format!("cannot start {:?}: {error}", request.argv[0]);
                supervisor_log::warn(&format!("run {}: {reason}", request.run_id));
                state.last_ended = Some((request.run_id.clone(), Ending::Failed(reason.clone())));
                send(&mut state, SupervisorMessage::Failed { run_id: request.run_id, reason });
                return;
            }
        };
        let epoch = state.next_epoch;
        state.next_epoch += 1;
        supervisor_log::info(&format!("run {} started as pid {}", request.run_id, run.pid));
        let mut open_streams = 0;
        for (stream, file) in run.output {
            let supervisor = Arc::clone(self);
            let run_id = request.run_id.clone();
            let started = std::thread::Builder::new()
                .name(format!("output-{}", stream.code()))
                .spawn(move || read_output(supervisor, epoch, stream, file, run_id));
            match started {
                Ok(_) => open_streams += 1,
                Err(error) => {
                    supervisor_log::error(&format!("run {}: cannot read its output: {error}", request.run_id));
                    signal_or_log(run.pid, libc::SIGKILL, &request.run_id);
                }
            }
        }
        let (stdin, input) = std_mpsc::channel::<Vec<u8>>();
        let input_run = request.run_id.clone();
        let stdin_file = run.stdin;
        if let Err(error) = std::thread::Builder::new()
            .name("input".into())
            .spawn(move || write_input(input, stdin_file, input_run))
        {
            supervisor_log::error(&format!("run {}: cannot write its input: {error}", request.run_id));
        }
        state.live = Some(LiveRun {
            run_id: request.run_id.clone(),
            epoch,
            pid: run.pid,
            stdin,
            pty_master: run.pty_master,
            open_streams,
            exit: None,
            stopping: false,
        });
        send(&mut state, SupervisorMessage::Started { run_id: request.run_id });
    }

    pub fn handle_stop(self: &Arc<Self>, run_id: String, grace_ms: u64) {
        let mut state = self.lock();
        if let Some(live) = state.live.as_mut().filter(|live| live.run_id == run_id) {
            if live.exit.is_none() && !live.stopping {
                live.stopping = true;
                supervisor_log::info(&format!("run {run_id}: stopping, SIGKILL after {grace_ms} ms"));
                signal_or_log(live.pid, libc::SIGTERM, &run_id);
                let epoch = live.epoch;
                let supervisor = Arc::clone(self);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(grace_ms)).await;
                    supervisor.kill_run(epoch);
                });
            }
            return;
        }
        let message = match &state.last_ended {
            Some((ended, ending)) if *ended == run_id => ending_message(ended, ending),
            _ => SupervisorMessage::Refused { run_id, code: RefusalCode::NoRun },
        };
        send(&mut state, message);
    }

    pub fn handle_resize(&self, cols: u16, rows: u16) {
        let state = self.lock();
        let Some(live) = state.live.as_ref().filter(|live| live.exit.is_none()) else {
            return;
        };
        if let Some(master) = &live.pty_master {
            if let Err(error) = run_process::resize_pty(master, cols, rows) {
                supervisor_log::warn(&format!("run {}: resize failed: {error}", live.run_id));
            }
        }
    }

    /// Input with no live run is discarded.
    pub fn handle_stdin(&self, bytes: Vec<u8>) {
        let state = self.lock();
        if let Some(live) = &state.live {
            // Refused only once the writer ended, which logged why.
            let _ = live.stdin.send(bytes);
        }
    }

    /// `false` when the bytes belong to a run that already ended.
    fn push_output(&self, epoch: u64, stream: OutputStream, bytes: &[u8]) -> bool {
        let mut state = self.lock();
        if state.live.as_ref().map(|live| live.epoch) != Some(epoch) {
            return false;
        }
        match state.ring.push(stream, bytes) {
            Ok(frame) => {
                send_outgoing(&mut state, Outgoing::Binary(frame));
                true
            }
            Err(_) => {
                supervisor_log::error("output seq exhausted its 32 bits; the supervisor exits");
                std::process::exit(70);
            }
        }
    }

    fn stream_closed(&self, epoch: u64) {
        let mut state = self.lock();
        if let Some(live) = state.live.as_mut().filter(|live| live.epoch == epoch) {
            live.open_streams -= 1;
            self.finish_if_done(&mut state);
        }
    }

    pub fn reap(self: &Arc<Self>) {
        let ended = {
            let _reaping = self.spawn_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            run_process::reap_all()
        };
        match ended {
            Ok(ended) => {
                for (pid, outcome) in ended {
                    self.child_exited(pid, outcome);
                }
            }
            Err(error) => supervisor_log::error(&format!("reaping children failed: {error}")),
        }
    }

    fn child_exited(self: &Arc<Self>, pid: i32, outcome: ExitOutcome) {
        let mut state = self.lock();
        let Some(live) = state.live.as_mut().filter(|live| live.pid == pid && live.exit.is_none()) else {
            return;
        };
        supervisor_log::info(&format!("run {} ended: {outcome:?}", live.run_id));
        live.exit = Some(outcome);
        // What the run left in its group goes with it.
        signal_or_log(live.pid, libc::SIGKILL, &live.run_id);
        if live.open_streams > 0 {
            let epoch = live.epoch;
            let supervisor = Arc::clone(self);
            tokio::spawn(async move {
                tokio::time::sleep(DRAIN_AFTER_EXIT).await;
                supervisor.end_draining(epoch);
            });
        }
        self.finish_if_done(&mut state);
    }

    fn kill_run(&self, epoch: u64) {
        let state = self.lock();
        if let Some(live) = state.live.as_ref().filter(|live| live.epoch == epoch && live.exit.is_none()) {
            supervisor_log::info(&format!("run {}: grace elapsed, SIGKILL", live.run_id));
            signal_or_log(live.pid, libc::SIGKILL, &live.run_id);
        }
    }

    fn end_draining(&self, epoch: u64) {
        let mut state = self.lock();
        if let Some(live) = state.live.as_mut().filter(|live| live.epoch == epoch) {
            supervisor_log::warn(&format!(
                "run {}: its output is still open {} ms after it ended; reporting it ended",
                live.run_id,
                DRAIN_AFTER_EXIT.as_millis()
            ));
            live.open_streams = 0;
            self.finish_if_done(&mut state);
        }
    }

    fn finish_if_done(&self, state: &mut State) {
        let done = state.live.as_ref().is_some_and(|live| live.exit.is_some() && live.open_streams == 0);
        if !done {
            return;
        }
        let Some(live) = state.live.take() else {
            return;
        };
        let ending = Ending::Exited(live.exit.expect("checked above"));
        let message = ending_message(&live.run_id, &ending);
        state.last_ended = Some((live.run_id, ending));
        send(state, message);
        if state.shutting_down {
            self.idle.notify_one();
        }
    }

    /// `true` while a run is live: the caller waits for `idle`.
    pub fn begin_shutdown(&self) -> bool {
        let mut state = self.lock();
        state.shutting_down = true;
        match &state.live {
            None => false,
            Some(live) => {
                if live.exit.is_none() {
                    supervisor_log::info(&format!("run {}: forwarding SIGTERM", live.run_id));
                    signal_or_log(live.pid, libc::SIGTERM, &live.run_id);
                }
                true
            }
        }
    }

    /// Closes the connection after everything already queued on it.
    pub fn end_connection(&self, code: u16, reason: &str) {
        let mut state = self.lock();
        if let Some(connection) = state.connection.take() {
            connection.close_with(ConnectionClose { code, reason: reason.to_string(), flush: true });
        }
    }
}

fn ending_message(run_id: &str, ending: &Ending) -> SupervisorMessage {
    let run_id = run_id.to_string();
    match ending {
        Ending::Exited(ExitOutcome::Code(code)) => SupervisorMessage::Exited { run_id, code: Some(*code), signal: None },
        Ending::Exited(ExitOutcome::Signal(signal)) => {
            SupervisorMessage::Exited { run_id, code: None, signal: Some(signal.clone()) }
        }
        Ending::Failed(reason) => SupervisorMessage::Failed { run_id, reason: reason.clone() },
    }
}

fn send(state: &mut State, message: SupervisorMessage) {
    send_outgoing(state, Outgoing::Text(message.encode()));
}

/// A message with no connection to take it is not queued: a reconnecting runner
/// learns the state from `hello`, the output from the ring, and an ending by
/// asking again.
fn send_outgoing(state: &mut State, message: Outgoing) {
    let Some(connection) = &state.connection else {
        return;
    };
    if !connection.offer(message) {
        if let Some(connection) = state.connection.take() {
            supervisor_log::warn(&format!("connection {} is backlogged; dropping it", connection.id));
            connection.close(close_code::BACKLOGGED, "the runner is not reading its output".into());
        }
    }
}

fn signal_or_log(pgid: i32, signal: libc::c_int, run_id: &str) {
    if let Err(error) = run_process::signal_group(pgid, signal) {
        supervisor_log::error(&format!(
            "run {run_id}: cannot send {} to its group: {error}",
            run_process::signal_name(signal)
        ));
    }
}

fn read_output(supervisor: Arc<Supervisor>, epoch: u64, stream: OutputStream, mut file: File, run_id: String) {
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut late_reported = false;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                if !supervisor.push_output(epoch, stream, &buffer[..n]) && !late_reported {
                    late_reported = true;
                    supervisor_log::warn(&format!("run {run_id}: output after it ended is dropped"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            // A pty master reads EIO once no process holds the slave.
            Err(error) if stream == OutputStream::Tty && error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => {
                supervisor_log::error(&format!("run {run_id}: reading its output failed: {error}"));
                break;
            }
        }
    }
    supervisor.stream_closed(epoch);
}

fn write_input(input: std_mpsc::Receiver<Vec<u8>>, mut file: File, run_id: String) {
    for bytes in input {
        if let Err(error) = file.write_all(&bytes) {
            supervisor_log::warn(&format!("run {run_id}: its stdin is closed ({error}); further input is discarded"));
            return;
        }
    }
}
