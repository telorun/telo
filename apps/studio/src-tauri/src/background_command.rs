//! Every process the shell starts is a console program (`docker`, `telo`,
//! `taskkill`), and on Windows a console program started from a GUI process
//! gets a console window of its own. `CREATE_NO_WINDOW` gives it a hidden one
//! instead; its own children inherit that console, so they stay hidden too.

use std::ffi::OsStr;

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}
