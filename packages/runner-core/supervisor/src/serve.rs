//! The supervisor's main loop: accepting runner connections, reaping every
//! child, and shutting down when the container is told to stop. No Node twin —
//! the crate runs where no runtime is (see the crate README).

use std::fs::File;
use std::io::{self, Read};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

use crate::connection::serve_connection;
use crate::run_process;
use crate::supervisor::Supervisor;
use crate::supervisor_config::SupervisorConfig;
use crate::supervisor_log;

pub async fn serve(config: SupervisorConfig) -> io::Result<()> {
    run_process::become_subreaper()?;
    let mut children = signal(SignalKind::child())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let listener = TcpListener::bind(config.listen).await?;
    supervisor_log::info(&format!("listening on {}", listener.local_addr()?));

    let supervisor = Arc::new(Supervisor::new(config.workspace, instance_id()?));
    let token: Arc<[u8]> = config.token.into();
    let mut next_connection = 1u64;
    supervisor.reap();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let id = next_connection;
                    next_connection += 1;
                    supervisor_log::info(&format!("connection {id} from {peer}"));
                    tokio::spawn(serve_connection(Arc::clone(&supervisor), stream, Arc::clone(&token), id));
                }
                Err(error) => {
                    supervisor_log::error(&format!("accepting a connection failed: {error}"));
                    // Out of descriptors, typically: let a run end before trying again.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            _ = children.recv() => supervisor.reap(),
            _ = terminate.recv() => break,
            _ = interrupt.recv() => break,
        }
    }

    supervisor_log::info("shutting down");
    if supervisor.begin_shutdown() {
        loop {
            tokio::select! {
                _ = children.recv() => supervisor.reap(),
                _ = supervisor.idle.notified() => break,
            }
        }
    }
    supervisor.end_connection(1001, "the supervisor is shutting down");
    // Lets the writer flush the ending and the close before the process exits.
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(())
}

/// A random id per process, so a runner tells a restarted supervisor from the
/// one whose seqs it holds.
fn instance_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| io::Error::new(error.kind(), format!("reading /dev/urandom: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
