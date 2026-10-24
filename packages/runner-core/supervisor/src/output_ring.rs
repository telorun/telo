//! The bounded ring of output frames a reconnecting runner is replayed from.
//! The runner's own ring is `packages/runner-core/src/session/byte-ring-buffer.ts`;
//! this one has no Node twin because the crate runs where no runtime is.

use std::collections::VecDeque;

use crate::protocol::{encode_output_frame, OutputStream};

/// What the ring keeps: 1 MiB of payload, and always the newest frame.
pub const RING_BYTES: usize = 1 << 20;

pub struct OutputRing {
    /// Encoded frames, oldest first.
    frames: VecDeque<(u32, Vec<u8>)>,
    payload_bytes: usize,
    max_bytes: usize,
    latest_seq: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SeqExhausted;

impl OutputRing {
    pub fn new(max_bytes: usize) -> Self {
        OutputRing { frames: VecDeque::new(), payload_bytes: 0, max_bytes, latest_seq: 0 }
    }

    /// Assigns the next seq and returns the encoded frame.
    pub fn push(&mut self, stream: OutputStream, payload: &[u8]) -> Result<Vec<u8>, SeqExhausted> {
        let seq = self.latest_seq.checked_add(1).ok_or(SeqExhausted)?;
        self.latest_seq = seq;
        let frame = encode_output_frame(seq, stream, payload);
        self.payload_bytes += payload.len();
        self.frames.push_back((seq, frame.clone()));
        while self.payload_bytes > self.max_bytes && self.frames.len() > 1 {
            if let Some((_, dropped)) = self.frames.pop_front() {
                self.payload_bytes -= dropped.len() - crate::protocol::FRAME_HEADER_BYTES;
            }
        }
        Ok(frame)
    }

    /// Every retained frame with a seq above `last_seq`, oldest first.
    pub fn after(&self, last_seq: u32) -> impl Iterator<Item = &Vec<u8>> {
        self.frames.iter().filter(move |(seq, _)| *seq > last_seq).map(|(_, frame)| frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_the_oldest_past_its_bound_and_keeps_the_newest() {
        let mut ring = OutputRing::new(4);
        ring.push(OutputStream::Stdout, b"ab").unwrap();
        ring.push(OutputStream::Stdout, b"cd").unwrap();
        ring.push(OutputStream::Stdout, b"ef").unwrap();
        let seqs: Vec<u8> = ring.after(0).map(|frame| frame[3]).collect();
        assert_eq!(seqs, vec![2, 3]);
        ring.push(OutputStream::Stdout, b"0123456789").unwrap();
        let seqs: Vec<u8> = ring.after(0).map(|frame| frame[3]).collect();
        assert_eq!(seqs, vec![4]);
    }

    #[test]
    fn refuses_a_seq_past_its_range() {
        let mut ring = OutputRing::new(4);
        ring.latest_seq = u32::MAX;
        assert_eq!(ring.push(OutputStream::Tty, b"x"), Err(SeqExhausted));
    }
}
