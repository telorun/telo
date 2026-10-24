//! One runner connection: the upgrade, the bearer check, the `hello` exchange,
//! then control messages and stdin in, everything the supervisor sends out. No
//! Node twin — the crate runs where no runtime is (see the crate README).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{header, StatusCode};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::bearer_token::{self, Credential};
use crate::protocol::{close_code, parse_runner_message, RunnerMessage, PATH};
use crate::supervisor::{ConnectionClose, ConnectionHandles, Outgoing, Supervisor};
use crate::supervisor_log;

/// How long a connection may stay open without saying `hello`.
pub const HELLO_WINDOW: Duration = Duration::from_secs(10);

type Socket = WebSocketStream<TcpStream>;

pub async fn serve_connection(supervisor: Arc<Supervisor>, stream: TcpStream, token: Arc<[u8]>, id: u64) {
    let mut authorization: Option<Vec<u8>> = None;
    let inspect = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        if request.uri().path() != PATH {
            let mut refusal = ErrorResponse::new(Some(format!("no route; the supervisor serves {PATH}\n")));
            *refusal.status_mut() = StatusCode::NOT_FOUND;
            return Err(refusal);
        }
        authorization = request.headers().get(header::AUTHORIZATION).map(|value| value.as_bytes().to_vec());
        Ok(response)
    };
    let socket = match tokio_tungstenite::accept_hdr_async(stream, inspect).await {
        Ok(socket) => socket,
        Err(error) => {
            supervisor_log::info(&format!("connection {id} refused at the upgrade: {error}"));
            return;
        }
    };
    match bearer_token::judge(authorization.as_deref(), &token) {
        Credential::Valid => {}
        Credential::Missing => {
            supervisor_log::warn(&format!("connection {id} carried no bearer token"));
            return close(socket, close_code::TOKEN_MISSING, "a bearer token is required").await;
        }
        Credential::Invalid => {
            supervisor_log::warn(&format!("connection {id} carried a wrong token"));
            return close(socket, close_code::TOKEN_INVALID, "the bearer token is not this supervisor's").await;
        }
    }
    let (mut sink, mut source) = socket.split();
    let last_seq = match tokio::time::timeout(HELLO_WINDOW, source.next()).await {
        Err(_) => {
            return refuse(&mut sink, close_code::HELLO_TIMEOUT, "no hello within the hello window").await;
        }
        Ok(None) => return,
        Ok(Some(Err(error))) => {
            supervisor_log::info(&format!("connection {id} dropped before hello: {error}"));
            return;
        }
        Ok(Some(Ok(Message::Text(text)))) => match parse_runner_message(&text) {
            Ok(RunnerMessage::Hello { last_seq }) => last_seq,
            Ok(_) => {
                return refuse(&mut sink, close_code::PROTOCOL_ERROR, "the first message is hello").await;
            }
            Err(refusal) => {
                supervisor_log::warn(&format!("connection {id}: {}", refusal.reason()));
                return refuse(&mut sink, refusal.close_code(), &refusal.reason()).await;
            }
        },
        Ok(Some(Ok(Message::Close(_)))) => return,
        Ok(Some(Ok(_))) => {
            return refuse(&mut sink, close_code::PROTOCOL_ERROR, "the first message is hello").await;
        }
    };

    let (outgoing, queued) = mpsc::unbounded_channel();
    let (close_tx, close_rx) = oneshot::channel();
    let pending = Arc::new(AtomicUsize::new(0));
    supervisor.attach(id, ConnectionHandles { outgoing, close: close_tx, pending: Arc::clone(&pending) }, last_seq);
    supervisor_log::info(&format!("connection {id} attached from seq {last_seq}"));

    let mut writer = tokio::spawn(write_loop(sink, queued, close_rx, pending));
    tokio::select! {
        _ = read_loop(&supervisor, &mut source, id) => {}
        _ = &mut writer => {}
    }
    supervisor.detach(id);
    if !writer.is_finished() {
        // Detaching dropped the queue's sender; the writer closes and ends.
        if tokio::time::timeout(Duration::from_secs(1), &mut writer).await.is_err() {
            writer.abort();
        }
    }
    supervisor_log::info(&format!("connection {id} ended"));
}

async fn read_loop(supervisor: &Arc<Supervisor>, source: &mut SplitStream<Socket>, id: u64) {
    while let Some(message) = source.next().await {
        match message {
            Ok(Message::Text(text)) => match parse_runner_message(&text) {
                Ok(RunnerMessage::Run(request)) => supervisor.handle_run(request),
                Ok(RunnerMessage::Stop { run_id, grace_ms }) => supervisor.handle_stop(run_id, grace_ms),
                Ok(RunnerMessage::Resize { cols, rows }) => supervisor.handle_resize(cols, rows),
                Ok(RunnerMessage::Hello { .. }) => {
                    supervisor.close_connection(id, close_code::PROTOCOL_ERROR, "hello is sent once".into());
                    return;
                }
                Err(refusal) => {
                    supervisor_log::warn(&format!("connection {id}: {}", refusal.reason()));
                    supervisor.close_connection(id, refusal.close_code(), refusal.reason());
                    return;
                }
            },
            Ok(Message::Binary(bytes)) => supervisor.handle_stdin(bytes.to_vec()),
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(error) => {
                supervisor_log::info(&format!("connection {id} dropped: {error}"));
                return;
            }
        }
    }
}

async fn write_loop(
    mut sink: SplitSink<Socket, Message>,
    mut queued: mpsc::UnboundedReceiver<Outgoing>,
    mut close_rx: oneshot::Receiver<ConnectionClose>,
    pending: Arc<AtomicUsize>,
) {
    loop {
        tokio::select! {
            biased;
            closing = &mut close_rx => {
                if let Ok(close) = closing {
                    if close.flush {
                        while let Ok(outgoing) = queued.try_recv() {
                            if write(&mut sink, outgoing, &pending).await.is_err() {
                                return;
                            }
                        }
                    }
                    refuse(&mut sink, close.code, &close.reason).await;
                }
                return;
            }
            next = queued.recv() => {
                let Some(outgoing) = next else {
                    // Detached: the peer is usually gone already.
                    let _ = sink.close().await;
                    return;
                };
                if write(&mut sink, outgoing, &pending).await.is_err() {
                    // The peer is gone; the reader sees it and detaches.
                    return;
                }
            }
        }
    }
}

async fn write(
    sink: &mut SplitSink<Socket, Message>,
    outgoing: Outgoing,
    pending: &AtomicUsize,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let (len, message) = match outgoing {
        Outgoing::Text(text) => (text.len(), Message::Text(text.into())),
        Outgoing::Binary(bytes) => (bytes.len(), Message::Binary(bytes.into())),
    };
    let sent = sink.send(message).await;
    pending.fetch_sub(len, Ordering::AcqRel);
    sent
}

/// A close reason is at most 123 bytes; a longer one is cut at a char boundary.
fn close_frame(code: u16, reason: &str) -> Message {
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason[..end].to_string().into() }))
}

async fn close(mut socket: Socket, code: u16, reason: &str) {
    if let Err(error) = socket.send(close_frame(code, reason)).await {
        supervisor_log::info(&format!("closing a connection with {code} failed: {error}"));
    }
}

async fn refuse(sink: &mut SplitSink<Socket, Message>, code: u16, reason: &str) {
    if let Err(error) = sink.send(close_frame(code, reason)).await {
        supervisor_log::info(&format!("closing a connection with {code} failed: {error}"));
    }
}
