//! The path a failure took through the manifest — `kernel/specs/invocation-contract.md`
//! §5.5. Mirrors `../../../nodejs/src/failure-trace.ts`, less the symbol-keyed carrier
//! (a Rust error holds its frames as fields) and `raisedAt`, which only a step engine
//! sets.

use serde::{Deserialize, Serialize};

/// Frames beyond this many are cut, the innermost kept.
pub const FAILURE_FRAME_LIMIT: usize = 64;

/// One resource a failure passed through. `position` is 1-based.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureFrame {
    pub kind: String,
    pub name: String,
    /// The declaring module's source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// RFC 6901 pointer into the resource's declaration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<FramePosition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FramePosition {
    pub line: u32,
    pub column: u32,
}

impl FailureFrame {
    pub fn new(kind: impl Into<String>, name: impl Into<String>, module: Option<String>) -> Self {
        Self { kind: kind.into(), name: name.into(), module, pointer: None, position: None }
    }
}

/// A failure's trace: frames innermost first, and how many outer ones the bound cut.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FailureTrace {
    pub frames: Vec<FailureFrame>,
    pub dropped_frames_count: u64,
}

impl FailureTrace {
    /// Add the next, outer frame. `frame` is built only when it is kept.
    pub fn append(&mut self, frame: impl FnOnce() -> FailureFrame) {
        if self.frames.len() >= FAILURE_FRAME_LIMIT {
            self.dropped_frames_count += 1;
        } else {
            self.frames.push(frame());
        }
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty() && self.dropped_frames_count == 0
    }

    /// A trace a carrier restores: bounded, so a peer cannot hand over more than the limit.
    pub fn restored(mut frames: Vec<FailureFrame>, dropped_frames_count: u64) -> Self {
        let cut = frames.len().saturating_sub(FAILURE_FRAME_LIMIT) as u64;
        frames.truncate(FAILURE_FRAME_LIMIT);
        Self { frames, dropped_frames_count: dropped_frames_count.saturating_add(cut) }
    }
}

/// One line of a trace: `at <kind>.<name>#<pointer> (<file>:<line>:<column>)`.
pub fn failure_frame_line(frame: &FailureFrame) -> String {
    let pointer = match frame.pointer.as_deref() {
        Some(p) if !p.is_empty() => format!("#{p}"),
        _ => String::new(),
    };
    let place = match &frame.position {
        Some(p) => format!(" ({}:{}:{})", frame.module.as_deref().unwrap_or(""), p.line, p.column),
        None => String::new(),
    };
    format!("at {}.{}{pointer}{place}", frame.kind, frame.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_at_sixty_four_keeping_the_innermost_and_counting_the_cut() {
        let mut trace = FailureTrace::default();
        for index in 0..100 {
            trace.append(|| FailureFrame::new("Lib.K", format!("r{index}"), None));
        }
        assert_eq!(trace.frames.len(), 64);
        assert_eq!(trace.frames[0].name, "r0");
        assert_eq!(trace.dropped_frames_count, 36);
    }

    #[test]
    fn a_restored_trace_counts_the_cut_beside_what_it_carried() {
        let frames = (0..100).map(|index| FailureFrame::new("Lib.K", format!("r{index}"), None)).collect();
        let trace = FailureTrace::restored(frames, 5);
        assert_eq!(trace.frames.len(), 64);
        assert_eq!(trace.dropped_frames_count, 41);
    }

    #[test]
    fn writes_a_frame_as_a_line() {
        let mut frame = FailureFrame::new("Telo.Sequence", "s", None);
        assert_eq!(failure_frame_line(&frame), "at Telo.Sequence.s");
        frame.pointer = Some("/steps/1".into());
        assert_eq!(failure_frame_line(&frame), "at Telo.Sequence.s#/steps/1");
    }
}
