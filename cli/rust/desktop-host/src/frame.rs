//! The framed carrier of the controller protocol, byte for byte
//! (`kernel/specs/controller-protocol.md` §3.1).
//!
//! `sdk/rust/core` holds the typed frame but no frame codec, so this crate carries
//! its own: a frame is `length` u32 BE, `class` u8, `metaLength` u32 BE, `meta`, `data`.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use std::io::{self, Read};

/// The largest `length` a frame may carry, refused before the body is read.
pub const MAX_FRAME_LENGTH: u32 = 16_777_216;
pub const CLASS_MESSAGE: u8 = 0x01;
pub const CLASS_DATA: u8 = 0x02;

/// One frame: the class, the UTF-8 meta and the uninterpreted data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub class: u8,
    pub meta: String,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub enum FrameError {
    /// `length` over `MAX_FRAME_LENGTH`, refused before the body is read.
    TooLong(u32),
    /// `length` under 5: no room for the class byte and `metaLength`.
    TooShort(u32),
    /// `metaLength` beyond `length - 5`.
    MetaOverflow { meta_length: u32, available: u32 },
    MetaNotUtf8,
    UnknownClass(u8),
    /// The stream ended inside a frame.
    Truncated,
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::TooLong(n) => write!(f, "frame length {n} exceeds the {MAX_FRAME_LENGTH}-byte bound"),
            FrameError::TooShort(n) => write!(f, "frame length {n} is below the 5-byte minimum"),
            FrameError::MetaOverflow { meta_length, available } => {
                write!(f, "meta length {meta_length} exceeds the {available} bytes the frame holds")
            }
            FrameError::MetaNotUtf8 => write!(f, "frame meta is not well-formed UTF-8"),
            FrameError::UnknownClass(c) => write!(f, "frame class {c:#04x} is neither a message nor a data frame"),
            FrameError::Truncated => write!(f, "the stream ended inside a frame"),
            FrameError::Io(e) => write!(f, "read failed: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// The bytes of a message frame (class `0x01`, empty data) carrying `meta`.
pub fn encode_message_frame(meta: &str) -> Result<Vec<u8>, FrameError> {
    encode_frame(&Frame { class: CLASS_MESSAGE, meta: meta.to_owned(), data: Vec::new() })
}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, FrameError> {
    let length = 1u64 + 4 + frame.meta.len() as u64 + frame.data.len() as u64;
    if length > MAX_FRAME_LENGTH as u64 {
        return Err(FrameError::TooLong(u32::try_from(length).unwrap_or(u32::MAX)));
    }
    let mut bytes = Vec::with_capacity(4 + length as usize);
    bytes.extend_from_slice(&(length as u32).to_be_bytes());
    bytes.push(frame.class);
    bytes.extend_from_slice(&(frame.meta.len() as u32).to_be_bytes());
    bytes.extend_from_slice(frame.meta.as_bytes());
    bytes.extend_from_slice(&frame.data);
    Ok(bytes)
}

/// Reads frames off a byte stream.
pub struct FrameReader<R: Read> {
    inner: R,
}

impl<R: Read> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        FrameReader { inner }
    }

    /// The next frame, or `None` when the stream ends cleanly between frames.
    pub fn read_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        let mut prefix = [0u8; 4];
        match read_exact_or_eof(&mut self.inner, &mut prefix)? {
            Filled::Eof => return Ok(None),
            Filled::Partial => return Err(FrameError::Truncated),
            Filled::Full => {}
        }
        let length = u32::from_be_bytes(prefix);
        if length > MAX_FRAME_LENGTH {
            return Err(FrameError::TooLong(length));
        }
        if length < 5 {
            return Err(FrameError::TooShort(length));
        }
        let mut body = vec![0u8; length as usize];
        match read_exact_or_eof(&mut self.inner, &mut body)? {
            Filled::Full => {}
            _ => return Err(FrameError::Truncated),
        }
        let class = body[0];
        if class != CLASS_MESSAGE && class != CLASS_DATA {
            return Err(FrameError::UnknownClass(class));
        }
        let meta_length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]);
        let available = length - 5;
        if meta_length > available {
            return Err(FrameError::MetaOverflow { meta_length, available });
        }
        let meta_end = 5 + meta_length as usize;
        let meta = std::str::from_utf8(&body[5..meta_end]).map_err(|_| FrameError::MetaNotUtf8)?.to_owned();
        let data = body[meta_end..].to_vec();
        Ok(Some(Frame { class, meta, data }))
    }
}

enum Filled {
    Eof,
    Partial,
    Full,
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<Filled, FrameError> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => return Ok(if filled == 0 { Filled::Eof } else { Filled::Partial }),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    Ok(Filled::Full)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8]) -> Result<Vec<Frame>, FrameError> {
        let mut reader = FrameReader::new(bytes);
        let mut frames = Vec::new();
        while let Some(frame) = reader.read_frame()? {
            frames.push(frame);
        }
        Ok(frames)
    }

    #[test]
    fn writes_the_documented_layout() {
        let bytes = encode_message_frame("{}").unwrap();
        assert_eq!(bytes, [0, 0, 0, 7, 1, 0, 0, 0, 2, b'{', b'}']);
    }

    #[test]
    fn round_trips_message_and_data_frames() {
        let message = Frame { class: CLASS_MESSAGE, meta: "{\"a\":\"é\"}".into(), data: vec![] };
        let data = Frame { class: CLASS_DATA, meta: "m".into(), data: vec![0, 1, 2, 255] };
        let mut bytes = encode_frame(&message).unwrap();
        bytes.extend(encode_frame(&data).unwrap());
        assert_eq!(read_all(&bytes).unwrap(), vec![message, data]);
    }

    #[test]
    fn refuses_an_oversized_length_before_reading_the_body() {
        // Only the prefix follows: a reader that allocated first would report Truncated.
        let bytes = (MAX_FRAME_LENGTH + 1).to_be_bytes();
        assert!(matches!(read_all(&bytes), Err(FrameError::TooLong(n)) if n == MAX_FRAME_LENGTH + 1));
        assert!(matches!(read_all(&u32::MAX.to_be_bytes()), Err(FrameError::TooLong(_))));
    }

    #[test]
    fn accepts_the_maximum_length_prefix_and_refuses_to_write_past_it() {
        let meta = "x".repeat(MAX_FRAME_LENGTH as usize - 5);
        assert!(encode_message_frame(&meta).is_ok());
        assert!(matches!(encode_message_frame(&format!("{meta}x")), Err(FrameError::TooLong(_))));
    }

    #[test]
    fn refuses_a_length_below_five() {
        for length in 0u32..5 {
            let mut bytes = length.to_be_bytes().to_vec();
            bytes.extend(vec![0u8; length as usize]);
            assert!(matches!(read_all(&bytes), Err(FrameError::TooShort(n)) if n == length));
        }
    }

    #[test]
    fn refuses_a_meta_length_beyond_the_frame() {
        let bytes = [0, 0, 0, 6, 1, 0, 0, 0, 2, b'{'];
        assert!(matches!(read_all(&bytes), Err(FrameError::MetaOverflow { meta_length: 2, available: 1 })));
    }

    #[test]
    fn refuses_a_meta_that_is_not_utf8() {
        let bytes = [0, 0, 0, 6, 1, 0, 0, 0, 1, 0xff];
        assert!(matches!(read_all(&bytes), Err(FrameError::MetaNotUtf8)));
    }

    #[test]
    fn refuses_an_unknown_class() {
        let bytes = [0, 0, 0, 5, 9, 0, 0, 0, 0];
        assert!(matches!(read_all(&bytes), Err(FrameError::UnknownClass(9))));
    }

    #[test]
    fn a_stream_cut_inside_a_frame_is_truncated_and_one_cut_between_frames_is_clean() {
        let bytes = encode_message_frame("{}").unwrap();
        assert!(matches!(read_all(&bytes[..bytes.len() - 1]), Err(FrameError::Truncated)));
        assert!(matches!(read_all(&bytes[..2]), Err(FrameError::Truncated)));
        assert_eq!(read_all(&[]).unwrap(), vec![]);
    }
}
