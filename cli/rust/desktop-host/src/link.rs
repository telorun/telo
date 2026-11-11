//! The link to `telo run`: frames on stdin / stdout, each carrying an envelope.
//!
//! `telo run` mints the requests, with odd ids; the helper answers each with the
//! request's id and type, and mints its own notifications with even ids. A frame
//! this end refuses — a bad length, a data frame, a meta that is not an envelope, an
//! unknown type, a payload its table rejects, an even request id, a response
//! (the helper sends no requests, so none is outstanding) — is terminal.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use crate::envelope::{error_payload, ok_payload, parse_envelope, violation, write_envelope, Envelope, ProtocolError};
use crate::frame::{encode_message_frame, FrameReader, CLASS_MESSAGE};
use crate::helper::{Backend, Helper, Notifier};
use crate::messages::{Failure, Notification, Request, ResponseBody};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Writes frames; shared by the loop and by the toolkit's handlers.
pub struct LinkWriter {
    out: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicU64,
}

impl LinkWriter {
    pub fn new(out: impl Write + Send + 'static) -> Self {
        LinkWriter { out: Mutex::new(Box::new(out)), next_id: AtomicU64::new(2) }
    }

    pub fn send(&self, envelope: &Envelope) -> io::Result<()> {
        let frame = encode_message_frame(&write_envelope(envelope)).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        let mut out = self.out.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        out.write_all(&frame)?;
        out.flush()
    }

    pub fn respond(&self, id: u64, kind: &str, result: Result<ResponseBody, Failure>) -> io::Result<()> {
        let payload = match result {
            Ok(body) => ok_payload(body.to_value()),
            Err(failure) => error_payload(failure.code, &failure.message),
        };
        self.send(&Envelope { id, kind: kind.to_owned(), payload })
    }
}

impl Notifier for LinkWriter {
    fn notify(&self, notification: Notification) {
        let (kind, payload) = notification.to_wire();
        let id = self.next_id.fetch_add(2, Ordering::Relaxed);
        if let Err(error) = self.send(&Envelope { id, kind: kind.to_owned(), payload }) {
            // The host is gone or its pipe is broken; the reader sees the same end.
            eprintln!("telo-desktop-host: writing {kind} to the host failed: {error}");
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Inbound {
    Request { id: u64, kind: String, request: Request },
    /// The host closed its end between frames.
    Closed,
    /// A refused frame; the link ends.
    Violation(String),
}

pub fn read_inbound<R: Read>(reader: &mut FrameReader<R>) -> Inbound {
    let frame = match reader.read_frame() {
        Ok(Some(frame)) => frame,
        Ok(None) => return Inbound::Closed,
        Err(error) => return Inbound::Violation(error.to_string()),
    };
    match request_of(frame.class, &frame.meta, frame.data.is_empty()) {
        Ok((id, kind, request)) => Inbound::Request { id, kind, request },
        Err(error) => Inbound::Violation(error.0),
    }
}

fn request_of(class: u8, meta: &str, data_empty: bool) -> Result<(u64, String, Request), ProtocolError> {
    if class != CLASS_MESSAGE || !data_empty {
        return Err(violation("a frame on this link must be a message frame with empty data"));
    }
    let envelope = parse_envelope(meta)?;
    if envelope.id % 2 == 0 {
        return Err(violation(format!("'{}' carries the even id {}, which only the helper mints", envelope.kind, envelope.id)));
    }
    let request = Request::parse(&envelope.kind, &envelope.payload)?;
    Ok((envelope.id, envelope.kind, request))
}

/// Serves one request and writes its response.
pub fn dispatch(helper: &mut Helper, backend: &mut dyn Backend, writer: &LinkWriter, id: u64, kind: &str, request: Request) -> io::Result<()> {
    let result = helper.handle(backend, request);
    writer.respond(id, kind, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{encode_frame, Frame, CLASS_DATA};
    use crate::helper::testing::Fake;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn frames_written(sink: &Sink) -> Vec<Value> {
        let bytes = sink.0.lock().unwrap().clone();
        let mut reader = FrameReader::new(bytes.as_slice());
        let mut out = Vec::new();
        while let Some(frame) = reader.read_frame().unwrap() {
            assert_eq!(frame.class, CLASS_MESSAGE);
            assert!(frame.data.is_empty());
            out.push(serde_json::from_str(&frame.meta).unwrap());
        }
        out
    }

    fn inbound(envelope: Value) -> Inbound {
        let bytes = encode_message_frame(&envelope.to_string()).unwrap();
        read_inbound(&mut FrameReader::new(bytes.as_slice()))
    }

    #[test]
    fn a_request_is_served_and_answered_with_its_id_and_type() {
        let sink = Sink::default();
        let writer = LinkWriter::new(sink.clone());
        let mut helper = Helper::new(true);
        let mut backend = Fake::default();
        let init = json!({ "id": 1, "type": "Helper.Init", "payload": {
            "identifier": "a.b", "productName": "P", "origin": "http://127.0.0.1:1", "hostOrigin": "http://127.0.0.1:2",
            "webviewDirectory": if cfg!(windows) { "C:\\w" } else { "/w" }, "showInDock": true } });
        let Inbound::Request { id, kind, request } = inbound(init) else { panic!() };
        dispatch(&mut helper, &mut backend, &writer, id, &kind, request).unwrap();
        let quit = json!({ "id": 3, "type": "Window.Show", "payload": { "window": "none" } });
        let Inbound::Request { id, kind, request } = inbound(quit) else { panic!() };
        dispatch(&mut helper, &mut backend, &writer, id, &kind, request).unwrap();
        assert_eq!(
            frames_written(&sink),
            vec![
                json!({ "id": 1, "type": "Helper.Init", "payload": { "ok": {} } }),
                json!({ "id": 3, "type": "Window.Show", "payload": { "error": { "code": "ERR_DESKTOP_HOST_UNKNOWN_ENTRY", "message": "no window 'none' is held" } } }),
            ]
        );
    }

    #[test]
    fn notifications_carry_even_ids_in_sequence() {
        let sink = Sink::default();
        let writer = LinkWriter::new(sink.clone());
        writer.notify(Notification::Reopened);
        writer.notify(Notification::TrayClicked { tray: "t".into() });
        let written = frames_written(&sink);
        assert_eq!(written[0], json!({ "id": 2, "type": "Helper.Reopened", "payload": {} }));
        assert_eq!(written[1], json!({ "id": 4, "type": "Tray.Clicked", "payload": { "tray": "t" } }));
    }

    #[test]
    fn what_the_helper_refuses_is_a_violation() {
        let data_frame = encode_frame(&Frame { class: CLASS_DATA, meta: "{}".into(), data: vec![] }).unwrap();
        assert!(matches!(read_inbound(&mut FrameReader::new(data_frame.as_slice())), Inbound::Violation(_)));
        let with_data = encode_frame(&Frame { class: CLASS_MESSAGE, meta: "{}".into(), data: vec![1] }).unwrap();
        assert!(matches!(read_inbound(&mut FrameReader::new(with_data.as_slice())), Inbound::Violation(_)));
        for envelope in [
            json!({ "id": 2, "type": "Helper.Quit", "payload": {} }),
            json!({ "id": 1, "type": "Helper.Nope", "payload": {} }),
            json!({ "id": 1, "type": "Window.Show", "payload": {} }),
            json!({ "id": 1, "type": "Window.Closed", "payload": { "window": "w" } }),
            json!({ "id": 1, "type": "Helper.Quit", "payload": { "ok": {} } }),
        ] {
            assert!(matches!(inbound(envelope.clone()), Inbound::Violation(_)), "{envelope}");
        }
        let oversized = (crate::frame::MAX_FRAME_LENGTH + 1).to_be_bytes();
        assert!(matches!(read_inbound(&mut FrameReader::new(oversized.as_slice())), Inbound::Violation(_)));
    }

    #[test]
    fn a_clean_end_of_input_is_closed() {
        assert_eq!(read_inbound(&mut FrameReader::new(&[][..])), Inbound::Closed);
    }
}
