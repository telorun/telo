//! `supervisor --slots <n>`: every slot listens on its own port of the base
//! address, and SIGTERM brings the whole container's supervisors down.

#![cfg(unix)]

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SLOTS: u16 = 3;

fn free_run_of_ports() -> u16 {
    loop {
        let first = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        if first > u16::MAX - SLOTS {
            continue;
        }
        if (0..SLOTS).all(|offset| TcpListener::bind(("127.0.0.1", first + offset)).is_ok()) {
            return first;
        }
    }
}

fn listening(port: u16) -> bool {
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn every_slot_listens_and_sigterm_ends_them_all() {
    let first = free_run_of_ports();
    let mut launcher = Command::new(env!("CARGO_BIN_EXE_supervisor"))
        .args(["--slots", &SLOTS.to_string()])
        .env("TELO_SUPERVISOR_LISTEN", format!("127.0.0.1:{first}"))
        .env("TELO_SUPERVISOR_TOKEN", "token")
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    for offset in 0..SLOTS {
        wait_until(&format!("slot {offset} to listen"), || listening(first + offset));
    }

    unsafe {
        libc::kill(launcher.id() as libc::pid_t, libc::SIGTERM);
    }
    let status = launcher.wait().unwrap();
    assert!(status.success(), "launcher exited {status}");
    for offset in 0..SLOTS {
        assert!(!listening(first + offset), "slot {offset} is still listening");
    }
}

#[test]
fn a_zero_slot_count_is_refused() {
    let status = Command::new(env!("CARGO_BIN_EXE_supervisor"))
        .args(["--slots", "0"])
        .env("TELO_SUPERVISOR_LISTEN", "127.0.0.1:0")
        .env("TELO_SUPERVISOR_TOKEN", "token")
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
}
