//! Starting one run as its own session and process group, on a fresh pty or on
//! pipes; signalling its group; reaping every child. No Node twin — the crate
//! runs where no runtime is (see the crate README).

use std::collections::BTreeMap;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::protocol::{IoMode, OutputStream, RunRequest};

/// The terminal size of a `tty` run that names none.
pub const DEFAULT_SIZE: (u16, u16) = (80, 24);
/// `TERM` of a `tty` run whose environment sets none, as a container engine sets it.
const DEFAULT_TERM: &str = "xterm";

pub struct SpawnedRun {
    pub pid: i32,
    /// Where the run's stdin bytes go: the pty master, or the stdin pipe.
    pub stdin: File,
    pub output: Vec<(OutputStream, File)>,
    /// The pty master, kept for resizing.
    pub pty_master: Option<OwnedFd>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExitOutcome {
    Code(i32),
    Signal(String),
}

pub fn resolve_cwd(cwd: &str, workspace: &Path) -> PathBuf {
    let path = Path::new(cwd);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    }
}

/// Starts the run. The caller holds the spawn lock, so no reaping runs while the
/// standard library waits on a child whose exec failed.
pub fn spawn(request: &RunRequest, workspace: &Path) -> io::Result<SpawnedRun> {
    let mut command = Command::new(&request.argv[0]);
    command.args(&request.argv[1..]);
    command.envs(&request.env);
    command.current_dir(resolve_cwd(&request.cwd, workspace));
    match request.io {
        IoMode::Tty => spawn_on_pty(command, request.size.unwrap_or(DEFAULT_SIZE), &request.env),
        IoMode::Streams => spawn_on_pipes(command),
    }
}

fn spawn_on_pipes(mut command: Command) -> io::Result<SpawnedRun> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            new_session()?;
            unblock_signals()
        });
    }
    let mut child = command.spawn()?;
    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    Ok(SpawnedRun {
        pid: child.id() as i32,
        stdin: File::from(OwnedFd::from(stdin)),
        output: vec![
            (OutputStream::Stdout, File::from(OwnedFd::from(stdout))),
            (OutputStream::Stderr, File::from(OwnedFd::from(stderr))),
        ],
        pty_master: None,
    })
}

fn spawn_on_pty(
    mut command: Command,
    (cols, rows): (u16, u16),
    env: &BTreeMap<String, String>,
) -> io::Result<SpawnedRun> {
    let (master, slave) = open_pty(cols, rows)?;
    if !env.contains_key("TERM") && std::env::var_os("TERM").is_none() {
        command.env("TERM", DEFAULT_TERM);
    }
    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            new_session()?;
            // fd 0 is the pty slave by now: make it the session's terminal.
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            unblock_signals()
        });
    }
    let child = command.spawn()?;
    // The slave copies the parent held went with `command`, so the master reads
    // EOF (EIO) once every process holding the slave is gone.
    drop(command);
    let reader = File::from(master.try_clone()?);
    let writer = File::from(master.try_clone()?);
    Ok(SpawnedRun {
        pid: child.id() as i32,
        stdin: writer,
        output: vec![(OutputStream::Tty, reader)],
        pty_master: Some(master),
    })
}

fn open_pty(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let size = window_size(cols, rows);
    let result = unsafe {
        libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &size)
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    set_cloexec(&master)?;
    set_cloexec(&slave)?;
    Ok((master, slave))
}

pub fn resize_pty(master: &OwnedFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = window_size(cols, rows);
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn window_size(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
}

fn set_cloexec(fd: &OwnedFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
    if flags == -1 || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn new_session() -> io::Result<()> {
    if unsafe { libc::setsid() } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn unblock_signals() -> io::Result<()> {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        if libc::pthread_sigmask(libc::SIG_SETMASK, &set, std::ptr::null_mut()) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Signals every process of the run's group. `false` when the group is gone.
pub fn signal_group(pgid: i32, signal: libc::c_int) -> io::Result<bool> {
    if unsafe { libc::kill(-pgid, signal) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error)
    }
}

/// Reaps every child that has ended, the run's and every orphan's.
pub fn reap_all() -> io::Result<Vec<(i32, ExitOutcome)>> {
    let mut ended = Vec::new();
    loop {
        let mut status: libc::c_int = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid == 0 {
            return Ok(ended);
        }
        if pid == -1 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ECHILD) => Ok(ended),
                Some(libc::EINTR) => continue,
                _ => Err(error),
            };
        }
        if libc::WIFEXITED(status) {
            ended.push((pid, ExitOutcome::Code(libc::WEXITSTATUS(status))));
        } else if libc::WIFSIGNALED(status) {
            ended.push((pid, ExitOutcome::Signal(signal_name(libc::WTERMSIG(status)))));
        }
    }
}

pub fn signal_name(signal: libc::c_int) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        libc::SIGSYS => "SIGSYS",
        other => return format!("SIG{other}"),
    };
    name.to_string()
}

/// Makes this process the reaper of every orphan beneath it when it is not
/// PID 1 (which already is), so a run's orphans are reaped the same either way.
#[cfg(target_os = "linux")]
pub fn become_subreaper() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn become_subreaper() -> io::Result<()> {
    Ok(())
}
