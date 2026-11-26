//! One port forward (`/v1/port-forward`): a WebSocket relaying raw bytes to and
//! from one TCP connection to `127.0.0.1:<port>`, independent of the connection
//! driving the supervisor. No Node twin — the crate runs where no runtime is (see
//! the crate README).

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::connection::close_frame;
use crate::protocol::{close_code, MAX_FORWARD_QUEUED_BYTES};
use crate::supervisor_log;

const READ_CHUNK_BYTES: usize = 64 * 1024;
/// How long an ending forward waits for its peer's close before it drops.
const CLOSE_WINDOW: Duration = Duration::from_secs(1);

type Socket = WebSocketStream<TcpStream>;

enum Outgoing {
    Bytes(Vec<u8>),
    Close(u16, String),
}

/// What is read from the port and not yet written to the WebSocket.
struct Queued {
    bytes: AtomicUsize,
    drained: Notify,
}

pub async fn serve_port_forward(mut socket: Socket, port: u16, id: u64) {
    let target = match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
        Ok(target) => target,
        Err(error) => {
            supervisor_log::info(&format!("port forward {id}: 127.0.0.1:{port} refused: {error}"));
            let reason = format!("nothing accepts a connection on 127.0.0.1:{port}: {error}");
            if let Err(error) = socket.send(close_frame(close_code::PORT_UNREACHABLE, &reason)).await {
                supervisor_log::info(&format!("port forward {id}: closing failed: {error}"));
            }
            return;
        }
    };
    supervisor_log::info(&format!("port forward {id} to 127.0.0.1:{port}"));
    let (from_port, to_port) = target.into_split();
    let (sink, mut source) = socket.split();
    let (outgoing, queue) = mpsc::unbounded_channel();
    let queued = Arc::new(Queued { bytes: AtomicUsize::new(0), drained: Notify::new() });

    let reader = tokio::spawn(read_port(from_port, outgoing.clone(), Arc::clone(&queued), id));
    let mut writer = tokio::spawn(write_socket(sink, queue, queued));
    let inbound = write_port(&mut source, to_port, id);
    tokio::pin!(inbound);
    tokio::select! {
        refusal = &mut inbound => {
            reader.abort();
            match refusal {
                Some((code, reason)) => {
                    // Delivered behind what is already queued, within the close window.
                    let _ = outgoing.send(Outgoing::Close(code, reason));
                }
                None => drop(outgoing),
            }
            if tokio::time::timeout(CLOSE_WINDOW, &mut writer).await.is_err() {
                writer.abort();
            }
        }
        _ = &mut writer => {
            reader.abort();
            // The close is written; the peer's own close ends the reading side.
            let _ = tokio::time::timeout(CLOSE_WINDOW, &mut inbound).await;
        }
    }
    supervisor_log::info(&format!("port forward {id} ended"));
}

/// The runner's binary frames, written to the port in order. Ends when the
/// runner closes or drops; a text frame is a refusal (`4400`).
async fn write_port(source: &mut SplitStream<Socket>, mut to_port: OwnedWriteHalf, id: u64) -> Option<(u16, String)> {
    while let Some(message) = source.next().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                if let Err(error) = to_port.write_all(&bytes).await {
                    supervisor_log::info(&format!("port forward {id}: writing to the port failed: {error}"));
                    return Some((close_code::PORT_UNREACHABLE, format!("the port's connection failed: {error}")));
                }
            }
            Ok(Message::Text(_)) => {
                supervisor_log::warn(&format!("port forward {id}: a text frame"));
                return Some((close_code::PROTOCOL_ERROR, "a port forward carries binary frames only".into()));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(error) => {
                supervisor_log::info(&format!("port forward {id} dropped: {error}"));
                break;
            }
        }
    }
    if let Err(error) = to_port.shutdown().await {
        supervisor_log::info(&format!("port forward {id}: ending the port's connection failed: {error}"));
    }
    None
}

/// The port's bytes, queued for the WebSocket. Reads nothing while more than
/// `MAX_FORWARD_QUEUED_BYTES` is queued; the port's ending closes the forward
/// `1000` behind every byte it sent.
async fn read_port(
    mut from_port: OwnedReadHalf,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    queued: Arc<Queued>,
    id: u64,
) {
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    loop {
        loop {
            let drained = queued.drained.notified();
            if queued.bytes.load(Ordering::Acquire) <= MAX_FORWARD_QUEUED_BYTES {
                break;
            }
            drained.await;
        }
        let close = match from_port.read(&mut buffer).await {
            Ok(0) => Outgoing::Close(1000, "the port's connection ended".into()),
            Ok(read) => {
                queued.bytes.fetch_add(read, Ordering::AcqRel);
                if outgoing.send(Outgoing::Bytes(buffer[..read].to_vec())).is_err() {
                    return;
                }
                continue;
            }
            Err(error) => {
                supervisor_log::info(&format!("port forward {id}: reading the port failed: {error}"));
                Outgoing::Close(close_code::PORT_UNREACHABLE, format!("the port's connection failed: {error}"))
            }
        };
        let _ = outgoing.send(close);
        return;
    }
}

async fn write_socket(
    mut sink: SplitSink<Socket, Message>,
    mut queue: mpsc::UnboundedReceiver<Outgoing>,
    queued: Arc<Queued>,
) {
    while let Some(next) = queue.recv().await {
        match next {
            Outgoing::Bytes(bytes) => {
                let len = bytes.len();
                let sent = sink.send(Message::Binary(bytes.into())).await;
                queued.bytes.fetch_sub(len, Ordering::AcqRel);
                queued.drained.notify_one();
                if sent.is_err() {
                    // The peer is gone; the reading side sees it.
                    return;
                }
            }
            Outgoing::Close(code, reason) => {
                if let Err(error) = sink.send(close_frame(code, &reason)).await {
                    supervisor_log::info(&format!("closing a port forward with {code} failed: {error}"));
                }
                return;
            }
        }
    }
    let _ = sink.close().await;
}
