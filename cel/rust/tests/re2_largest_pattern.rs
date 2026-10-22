//! The largest pattern RE2's size limit accepts — `\pL{1000}` written 3,355 times, ~30 KB of
//! text — compiles to the program Node's does and is searched, within Node's memory.
//!
//! Node's answers, executed (`@telorun/cel 0.120.1 at b4a2b6e9`, re2js 2.8.3 on Node
//! 24.21): the pattern is accepted with 3,355,002 instructions, one more copy is `expression
//! too large`, and `é` written 5,000 times does not match. Node's heap grew by 908 MB to
//! compile it (853 MB in planning's measurement) and its peak resident memory was 1,019 MB.
//! Here the bound is Node's 853 MB, held against this process's own peak resident memory
//! (`VmHWM`, which Linux keeps; elsewhere that half is not measured). This file holds one
//! test, so nothing else runs in its process.

use telorun_cel::{re2_pattern, Re2Flags};

const NODE_MEGABYTES: u64 = 853;

#[test]
fn compiles_and_searches_the_largest_accepted_pattern_within_nodes_memory() {
    let pattern = "\\pL{1000}".repeat(3355);
    let program = re2_pattern(&pattern, Re2Flags::NONE).expect("accepted");
    assert_eq!(program.instruction_count(), 3_355_002);
    assert_eq!(program.search(&"é".repeat(5000), 0, 1).groups, None);
    assert!(re2_pattern(&"\\pL{1000}".repeat(3356), Re2Flags::NONE).is_err());
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").expect("Linux reports the process's status");
        let peak_kilobytes: u64 = status
            .lines()
            .find_map(|line| line.strip_prefix("VmHWM:"))
            .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
            .expect("the status holds the peak resident size");
        assert!(peak_kilobytes / 1024 <= NODE_MEGABYTES, "peak resident memory {peak_kilobytes} kB");
    }
}
