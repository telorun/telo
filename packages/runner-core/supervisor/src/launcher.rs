//! `supervisor --slots <n>`: one container, `n` supervisors. The container's main
//! process starts `n` copies of this executable, each listening on the next port
//! of `TELO_SUPERVISOR_LISTEN`, so a runner holds `n` independent one-run slots
//! in a container it never has to recreate. No Node twin — the crate runs where
//! no runtime is (see the crate README). Each slot speaks the protocol unchanged.
//!
//! The launcher takes no part in any run: it forwards SIGTERM, and a slot that
//! ends brings the others and the container down, since a container with a slot
//! missing can no longer be driven as the runner believes.

use std::ffi::OsString;
use std::net::SocketAddr;
use std::process::{Child, Command, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::supervisor_config::{LISTEN_VARIABLE, TOKEN_VARIABLE};
use crate::supervisor_log;

const SLOTS_FLAG: &str = "--slots";
const POLL: Duration = Duration::from_millis(100);
const SLOT_GRACE: Duration = Duration::from_secs(30);

static TERMINATED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_terminate(_signal: libc::c_int) {
    TERMINATED.store(true, Ordering::SeqCst);
}

/// The slot count when the arguments ask for the launcher, with the arguments
/// every slot is started with.
pub fn slots_from(args: &[OsString]) -> Result<Option<(u16, Vec<OsString>)>, String> {
    let mut slots = None;
    let mut rest = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg.to_str() == Some(SLOTS_FLAG) {
            let value = iter.next().ok_or("--slots takes a count")?;
            let count: u16 = value
                .to_str()
                .and_then(|text| text.parse().ok())
                .filter(|count| *count > 0)
                .ok_or_else(|| format!("--slots {value:?} is not a positive count"))?;
            slots = Some(count);
        } else {
            rest.push(arg.clone());
        }
    }
    Ok(slots.map(|count| (count, rest)))
}

pub fn run(slots: u16, args: Vec<OsString>) -> ExitCode {
    let (listen, token) = match base_configuration() {
        Ok(found) => found,
        Err(message) => {
            supervisor_log::error(&message);
            return ExitCode::from(2);
        }
    };
    if u32::from(listen.port()) + u32::from(slots) > u32::from(u16::MAX) + 1 {
        supervisor_log::error(&format!("{slots} slots from port {} pass the last port", listen.port()));
        return ExitCode::from(2);
    }
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            supervisor_log::error(&format!("cannot find its own executable: {error}"));
            return ExitCode::from(1);
        }
    };
    install_handlers();

    let mut children: Vec<Child> = Vec::new();
    for slot in 0..slots {
        let mut address = listen;
        address.set_port(listen.port() + slot);
        let started = Command::new(&executable)
            .args(&args)
            .env(LISTEN_VARIABLE, address.to_string())
            .env(TOKEN_VARIABLE, &token)
            .spawn();
        match started {
            Ok(child) => children.push(child),
            Err(error) => {
                supervisor_log::error(&format!("cannot start slot {slot}: {error}"));
                end(&mut children);
                return ExitCode::from(1);
            }
        }
    }
    supervisor_log::info(&format!("started {slots} slots from {listen}"));

    loop {
        if TERMINATED.load(Ordering::SeqCst) {
            end(&mut children);
            return ExitCode::SUCCESS;
        }
        for (slot, child) in children.iter_mut().enumerate() {
            if let Ok(Some(status)) = child.try_wait() {
                supervisor_log::error(&format!("slot {slot} ended ({status}); ending the others"));
                let code = status.code().unwrap_or(1);
                end(&mut children);
                return ExitCode::from(u8::try_from(code).ok().filter(|code| *code != 0).unwrap_or(1));
            }
        }
        std::thread::sleep(POLL);
    }
}

fn base_configuration() -> Result<(SocketAddr, String), String> {
    let listen = std::env::var(LISTEN_VARIABLE)
        .map_err(|_| format!("{LISTEN_VARIABLE} is required (an address such as 0.0.0.0:7070)"))?;
    let listen = listen
        .parse()
        .map_err(|error| format!("{LISTEN_VARIABLE} {listen:?} is not an ip:port address: {error}"))?;
    let token = std::env::var(TOKEN_VARIABLE).map_err(|_| format!("{TOKEN_VARIABLE} is required"))?;
    if token.trim().is_empty() {
        return Err(format!("{TOKEN_VARIABLE} must not be empty"));
    }
    Ok((listen, token))
}

fn install_handlers() {
    let handler = on_terminate as extern "C" fn(libc::c_int) as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

/// SIGTERM to every slot that is still up, then wait for them. A slot stops its
/// live run first (the protocol's shutdown), so this waits as long as a run needs
/// to end; the container engine's own grace is what bounds it.
fn end(children: &mut [Child]) {
    for child in children.iter() {
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + SLOT_GRACE;
    for child in children.iter_mut() {
        while matches!(child.try_wait(), Ok(None)) {
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(POLL);
        }
    }
}
