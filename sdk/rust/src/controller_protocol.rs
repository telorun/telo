//! The Telo controller protocol's conformance run — `kernel/specs/controller-protocol.md`.
//!
//! The Rust twin of `sdk/nodejs/tests/controller-protocol.test.ts`: the same four
//! vector files under `sdk/controller-protocol/vectors/`, executed row for row, so
//! a claim the spec makes is a claim both languages answer identically.
//!
//! The module carries no implementation. The protocol's carriers are later steps,
//! and the framing codec inside `mod tests` is **private to the test**, written
//! from §3's prose rather than from the vectors — whoever writes the real carrier
//! re-derives it, so the vectors never end up testing a codec against itself.

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet, HashMap};

    use serde_json::Value as Json;

    use crate::typed_frame::{decode_typed_frame, encode_typed_frame, CelValue};

    const FRAMING: &str = include_str!("../../controller-protocol/vectors/framing.json");
    const MESSAGES: &str = include_str!("../../controller-protocol/vectors/messages.json");
    const SEQUENCES: &str = include_str!("../../controller-protocol/vectors/sequences.json");
    const CARRIER_EQUIVALENCE: &str =
        include_str!("../../controller-protocol/vectors/carrier-equivalence.json");

    const MESSAGE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../controller-protocol/messages");

    // -------------------------------------------------------------- framing
    // §3.1, §3.3. Nothing here is `pub`.

    const MAX_FRAME_LENGTH: usize = 16_777_216;
    const CHUNK_CEILING: usize = 8_388_608;
    const CLASS_MESSAGE: u8 = 0x01;
    const CLASS_DATA: u8 = 0x02;

    struct Envelope {
        id: u64,
        session: Option<String>,
        message: String,
        payload: Json,
    }

    struct Frame {
        class: &'static str,
        meta: String,
        data: Vec<u8>,
        envelope: Envelope,
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len() / 2)
            .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
            .collect()
    }

    /// length u32be | class u8 | metaLength u32be | meta | data
    fn encode_frame(class: &str, meta: &str, data: &[u8]) -> Result<Vec<u8>, String> {
        let meta_bytes = meta.as_bytes();
        let length = 1 + 4 + meta_bytes.len() + data.len();
        if length > MAX_FRAME_LENGTH {
            return Err(format!("a frame of {length} bytes exceeds MAX_FRAME_LENGTH"));
        }
        let mut out = Vec::with_capacity(4 + length);
        out.extend_from_slice(&(length as u32).to_be_bytes());
        out.push(if class == "message" { CLASS_MESSAGE } else { CLASS_DATA });
        out.extend_from_slice(&(meta_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(meta_bytes);
        out.extend_from_slice(data);
        Ok(out)
    }

    fn u32_at(bytes: &[u8], at: usize) -> usize {
        u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize
    }

    /// §3.2: the meta is the typed frame of an object with exactly four members.
    fn read_envelope(meta: &str) -> Result<Envelope, String> {
        let value = decode_typed_frame(meta).map_err(|err| format!("a frame's meta is not a typed frame: {err}"))?;
        let CelValue::Map(entries) = &value else {
            return Err("a frame's meta is not an envelope object".into());
        };
        let members: BTreeSet<&str> = entries
            .iter()
            .filter_map(|(key, _)| match key {
                CelValue::String(name) => Some(name.as_str()),
                _ => None,
            })
            .collect();
        if members.iter().copied().collect::<Vec<_>>() != ["id", "payload", "session", "type"] {
            return Err(format!(
                "an envelope carries exactly id, session, type and payload, not {members:?}"
            ));
        }
        let member = |name: &str| {
            entries
                .iter()
                .find(|(key, _)| matches!(key, CelValue::String(k) if k == name))
                .map(|(_, value)| value)
                .expect("the member")
        };
        let id = match member("id") {
            CelValue::Double(n) if n.fract() == 0.0 && *n >= 0.0 => *n as u64,
            _ => return Err("an envelope's id is an unsigned integer".into()),
        };
        let session = match member("session") {
            CelValue::Null => None,
            CelValue::String(text) => Some(text.clone()),
            _ => return Err("an envelope's session is text or null".into()),
        };
        let CelValue::String(message) = member("type") else {
            return Err("an envelope's type is the message's name".into());
        };
        // The payload as plain data, for the schema its message declares.
        let parsed: Json = serde_json::from_str(meta).map_err(|err| err.to_string())?;
        Ok(Envelope { id, session, message: message.clone(), payload: parsed["payload"].clone() })
    }

    fn decode_frame(bytes: &[u8]) -> Result<Frame, String> {
        if bytes.len() < 4 {
            return Err("a frame's four-byte length prefix is truncated".into());
        }
        let length = u32_at(bytes, 0);
        // Refused on the length field alone, before any body is read or allocated.
        if length > MAX_FRAME_LENGTH {
            return Err(format!("a length of {length} exceeds MAX_FRAME_LENGTH"));
        }
        if length < 5 {
            return Err(format!("a frame of length {length} carries no class byte and no metaLength"));
        }
        if bytes.len() != 4 + length {
            return Err(format!("a frame of length {length} is {} bytes long", bytes.len() - 4));
        }
        let class = bytes[4];
        if class != CLASS_MESSAGE && class != CLASS_DATA {
            return Err(format!("no frame class is 0x{class:02x}"));
        }
        let meta_length = u32_at(bytes, 5);
        if meta_length > length - 5 {
            return Err(format!("a metaLength of {meta_length} exceeds length - 5"));
        }
        let meta = std::str::from_utf8(&bytes[9..9 + meta_length])
            .map_err(|_| "a frame's meta is not well-formed UTF-8".to_string())?
            .to_string();
        let data = bytes[9 + meta_length..].to_vec();
        let envelope = read_envelope(&meta)?;
        if class == CLASS_MESSAGE {
            if !data.is_empty() {
                return Err("a message frame's whole content is its envelope".into());
            }
            return Ok(Frame { class: "message", meta, data, envelope });
        }
        if envelope.message != "Channel.Data" {
            return Err("Channel.Data is the only data frame".into());
        }
        if data.len() > CHUNK_CEILING {
            return Err(format!("a chunk of {} bytes exceeds the chunk ceiling", data.len()));
        }
        let declared = envelope.payload["byteLength"].as_u64();
        if declared != Some(data.len() as u64) {
            return Err(format!(
                "a chunk declared {declared:?} bytes and {} follow the meta",
                data.len()
            ));
        }
        Ok(Frame { class: "data", meta, data, envelope })
    }

    // -------------------------------------------------------------- schemas

    struct Messages {
        entries: BTreeMap<String, Json>,
        validators: HashMap<String, jsonschema::Validator>,
    }

    impl Messages {
        fn read() -> Self {
            let mut entries = BTreeMap::new();
            for file in std::fs::read_dir(MESSAGE_DIR).expect("the message directory") {
                let path = file.expect("a message file").path();
                let text = std::fs::read_to_string(&path).expect("a message file");
                let entry: Json = serde_json::from_str(&text).expect("a message file is JSON");
                entries.insert(entry["name"].as_str().expect("name").to_string(), entry);
            }
            Self { entries, validators: HashMap::new() }
        }

        fn entry(&self, message: &str) -> &Json {
            self.entries
                .get(message)
                .unwrap_or_else(|| panic!("No message named '{message}' in sdk/controller-protocol/messages/"))
        }

        fn validator(&mut self, message: &str, part: &str) -> &jsonschema::Validator {
            let key = format!("{message}#{part}");
            if !self.validators.contains_key(&key) {
                let schema = self.entry(message)[part].clone();
                assert!(!schema.is_null(), "'{message}' is a notification: it has no response schema");
                let validator = jsonschema::validator_for(&schema)
                    .unwrap_or_else(|err| panic!("{key} is not a usable schema: {err}"));
                self.validators.insert(key.clone(), validator);
            }
            &self.validators[&key]
        }

        /// The distinct RFC 6901 instance pointers a refusal names.
        fn refusals(&mut self, message: &str, part: &str, body: &Json) -> Vec<String> {
            let pointers: BTreeSet<String> = self
                .validator(message, part)
                .iter_errors(body)
                .map(|error| error.instance_path().to_string())
                .collect();
            pointers.into_iter().collect()
        }
    }

    fn vectors(text: &str) -> Json {
        serde_json::from_str(text).expect("a vector file is JSON")
    }

    fn rows<'a>(file: &'a Json, table: &str) -> &'a Vec<Json> {
        let table = file[table].as_array().expect("a vector table");
        assert!(!table.is_empty(), "a vector table with no rows is a silent zero");
        table
    }

    fn text<'a>(row: &'a Json, key: &str) -> &'a str {
        row[key].as_str().unwrap_or_else(|| panic!("'{key}' is text"))
    }

    // ---------------------------------------------------------------- tests

    #[test]
    fn frames_and_reads_every_framing_vector() {
        let file = vectors(FRAMING);
        let messages = Messages::read();
        for row in rows(&file, "frames") {
            let name = text(row, "name");
            let decoded = decode_frame(&unhex(text(row, "frame"))).unwrap_or_else(|err| panic!("{name}: {err}"));
            assert_eq!(decoded.class, text(row, "class"), "{name}");
            assert_eq!(decoded.meta, text(row, "meta"), "{name}");
            assert_eq!(hex(&decoded.data), text(row, "data"), "{name}");
            let written = encode_frame(text(row, "class"), text(row, "meta"), &unhex(text(row, "data")))
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            assert_eq!(hex(&written), text(row, "frame"), "{name}");
            // The meta is the canonical typed frame of the envelope it carries.
            let value = decode_typed_frame(text(row, "meta")).unwrap_or_else(|err| panic!("{name}: {err}"));
            assert_eq!(encode_typed_frame(&value).unwrap(), text(row, "meta"), "{name}");
            assert!(messages.entries.contains_key(&decoded.envelope.message), "{name}");
        }
    }

    #[test]
    fn refuses_every_undecodable_frame() {
        let file = vectors(FRAMING);
        for row in rows(&file, "undecodable") {
            let name = text(row, "name");
            let refusal = decode_frame(&unhex(text(row, "frame")));
            assert!(refusal.is_err(), "{name}: {}", text(row, "reason"));
        }
    }

    #[test]
    fn every_valid_message_body_satisfies_its_schema() {
        let file = vectors(MESSAGES);
        let mut messages = Messages::read();
        for row in rows(&file, "valid") {
            let (message, part) = (text(row, "message"), text(row, "part"));
            let refusals = messages.refusals(message, part, &row["body"]);
            assert!(refusals.is_empty(), "{message} {part} was refused at {refusals:?}");
        }
    }

    #[test]
    fn refuses_every_invalid_message_body_at_its_pointer() {
        let file = vectors(MESSAGES);
        let mut messages = Messages::read();
        for row in rows(&file, "invalid") {
            let (name, message, part) = (text(row, "name"), text(row, "message"), text(row, "part"));
            let refusals = messages.refusals(message, part, &row["body"]);
            assert!(!refusals.is_empty(), "{name} was accepted");
            assert_eq!(
                refusals,
                vec![text(row, "pointer").to_string()],
                "{name} names a place other than the pointer its row pins"
            );
        }
    }

    #[test]
    fn every_message_has_a_valid_body_in_every_direction_it_declares() {
        let file = vectors(MESSAGES);
        let messages = Messages::read();
        let covered: BTreeSet<String> = rows(&file, "valid")
            .iter()
            .map(|row| format!("{}#{}", text(row, "message"), text(row, "part")))
            .collect();
        let missing: Vec<String> = messages
            .entries
            .values()
            .flat_map(|entry| {
                let name = entry["name"].as_str().expect("name");
                let mut wanted = vec![format!("{name}#request")];
                if !entry["response"].is_null() {
                    wanted.push(format!("{name}#response"));
                }
                wanted
            })
            .filter(|key| !covered.contains(key))
            .collect();
        assert_eq!(missing, Vec::<String>::new());
    }

    struct Outstanding {
        message: String,
        session: Option<String>,
        from: String,
        synchronous: bool,
        index: usize,
        response: Option<usize>,
    }

    struct Channel {
        granted: i64,
        spent: i64,
        next_seq: u64,
        closed: bool,
    }

    /// Everything §3.2, §3.4, §8 and §10 decide about a whole exchange.
    fn check_sequence(row: &Json, messages: &mut Messages) {
        let name = text(row, "name");
        let frames = row["frames"].as_array().expect("frames");
        assert!(!frames.is_empty(), "{name} has no frames");
        let mut open: BTreeSet<String> =
            row["open"].as_array().expect("open").iter().map(|s| s.as_str().expect("session").to_string()).collect();
        let mut outstanding: BTreeMap<u64, Outstanding> = BTreeMap::new();
        let mut settled: Vec<Outstanding> = Vec::new();
        let mut channels: BTreeMap<String, Channel> = BTreeMap::new();

        for (index, frame) in frames.iter().enumerate() {
            let at = format!("{name}: frame {index}");
            let decoded = decode_frame(&unhex(text(frame, "frame"))).unwrap_or_else(|err| panic!("{at}: {err}"));
            assert_eq!(decoded.meta, text(frame, "meta"), "{at}");
            assert_eq!(hex(&decoded.data), frame["data"].as_str().unwrap_or(""), "{at}");

            let envelope = &decoded.envelope;
            let message = envelope.message.clone();
            let entry = messages.entry(&message).clone();
            let from = text(frame, "from").to_string();
            // §3.2: the kernel end mints even ids and the controller end odd ones,
            // so a frame's id alone says whether it is a request or a response.
            let is_request = envelope.id % 2 == if from == "kernel" { 0 } else { 1 };
            let payload = &envelope.payload;

            if is_request && message == "Session.Open" {
                open.insert(payload["session"].as_str().expect("session").to_string());
            }
            // Both directions: Session.Hello precedes every session and carries
            // none, and every other frame names one that is open.
            match &envelope.session {
                None => assert_eq!(message, "Session.Hello", "{at}: only Session.Hello precedes every session"),
                Some(session) => {
                    assert_ne!(message, "Session.Hello", "{at}: Session.Hello precedes every session");
                    assert!(open.contains(session), "{at} names session '{session}', which is not open");
                }
            }

            if is_request {
                if let Some(blocked) = outstanding.values().find(|out| out.from == from && out.synchronous) {
                    panic!("{at} was sent while '{}', a synchronous request, was outstanding", blocked.message);
                }
                assert!(!outstanding.contains_key(&envelope.id), "{at} reuses id {}", envelope.id);
                let refusals = messages.refusals(&message, "request", payload);
                assert!(refusals.is_empty(), "{at}: {message} request refused at {refusals:?}");
                if !entry["response"].is_null() {
                    outstanding.insert(
                        envelope.id,
                        Outstanding {
                            message: message.clone(),
                            session: envelope.session.clone(),
                            from: from.clone(),
                            synchronous: entry["synchronous"].as_bool().expect("synchronous"),
                            index,
                            response: None,
                        },
                    );
                }
            } else {
                let mut request = outstanding
                    .remove(&envelope.id)
                    .unwrap_or_else(|| panic!("{at} answers id {}, which no outstanding request carries", envelope.id));
                assert_eq!(request.message, message, "{at} answers '{}' with '{message}'", request.message);
                assert_eq!(request.session, envelope.session, "{at}");
                assert_ne!(request.from, from, "{at}: a response comes from the other end");
                assert!(
                    !entry["response"].is_null(),
                    "{at} answers '{message}', whose response is null — a notification draws no response"
                );
                let members: Vec<&String> = payload.as_object().expect("a response payload").keys().collect();
                assert_eq!(members.len(), 1, "{at}: a response payload carries exactly 'ok' or 'error'");
                if members[0] == "ok" {
                    let refusals = messages.refusals(&message, "response", &payload["ok"]);
                    assert!(refusals.is_empty(), "{at}: {message} response refused at {refusals:?}");
                    if message == "Session.Close" {
                        if let Some(session) = &request.session {
                            open.remove(session);
                        }
                    }
                    if message == "Runtime.Run" {
                        open.insert(payload["ok"]["session"].as_str().expect("session").to_string());
                    }
                } else {
                    assert_eq!(members[0], "error", "{at}");
                    let code = payload["error"]["code"].as_str().expect("code");
                    let declared: Vec<&str> =
                        entry["errors"].as_array().expect("errors").iter().map(|c| c.as_str().expect("code")).collect();
                    assert!(declared.contains(&code), "{at} answers with '{code}', which '{message}' does not declare");
                }
                request.response = Some(index);
                settled.push(request);
            }

            // §8: a chunk sits between its channel's Open and Close, in seq order,
            // and within the credit granted to it.
            if message == "Channel.Open" {
                channels.insert(
                    payload["channelId"].as_str().expect("channelId").to_string(),
                    Channel { granted: payload["credit"].as_i64().expect("credit"), spent: 0, next_seq: 0, closed: false },
                );
            } else if ["Channel.Credit", "Channel.Data", "Channel.Close"].contains(&message.as_str()) {
                let id = payload["channelId"].as_str().expect("channelId").to_string();
                let channel = channels
                    .get_mut(&id)
                    .unwrap_or_else(|| panic!("{at} names channel '{id}', which is not open"));
                assert!(!channel.closed, "{at} follows channel '{id}''s close");
                match message.as_str() {
                    "Channel.Credit" => channel.granted += payload["bytes"].as_i64().expect("bytes"),
                    "Channel.Data" => {
                        assert_eq!(
                            payload["seq"].as_u64().expect("seq"),
                            channel.next_seq,
                            "{at}: seq starts at 0 and increases by one"
                        );
                        channel.next_seq += 1;
                        channel.spent += payload["byteLength"].as_i64().expect("byteLength");
                        assert!(
                            channel.spent <= channel.granted,
                            "{at} spends {} bytes of {} granted",
                            channel.spent,
                            channel.granted
                        );
                    }
                    _ => channel.closed = true,
                }
            }
        }

        if let Some(reentrancy) = row.get("reentrancy") {
            let outer = text(reentrancy, "outer");
            let inner = text(reentrancy, "inner");
            let entry = messages.entry(outer);
            assert!(
                entry["synchronous"] == true && entry["reentrant"] == true,
                "{name}: '{outer}' is not a synchronous, reentrant message"
            );
            let call = settled
                .iter()
                .find(|request| request.message == outer)
                .unwrap_or_else(|| panic!("{name}: no '{outer}' exchange in this row"));
            let interleaved = frames.iter().enumerate().any(|(index, frame)| {
                index > call.index
                    && index < call.response.expect("a settled request")
                    && text(frame, "from") != text(&frames[call.index], "from")
                    && decode_frame(&unhex(text(frame, "frame"))).expect("a frame").envelope.message == inner
            });
            assert!(
                interleaved,
                "{name}: no '{inner}' request is interleaved between '{outer}' and its response"
            );
        }

        if let Some(signal) = row.get("signal") {
            let code = text(signal, "code");
            let answer = |message: &str| -> (String, usize) {
                let request = settled
                    .iter()
                    .find(|request| request.message == message)
                    .unwrap_or_else(|| panic!("{name}: no '{message}' exchange in this row"));
                let index = request.response.expect("a settled request");
                let payload = decode_frame(&unhex(text(&frames[index], "frame"))).expect("a frame").envelope.payload;
                (payload["error"]["code"].as_str().unwrap_or_default().to_string(), index)
            };
            let raised = answer(text(signal, "raisedBy"));
            let reraised = answer(text(signal, "reraisedBy"));
            assert_eq!(raised.0, code, "{name}");
            assert_eq!(reraised.0, code, "{name}: a signal leaves the construct that catches it unchanged");
            assert!(reraised.1 > raised.1, "{name}");
        }
    }

    #[test]
    fn every_exchange_is_well_formed() {
        let file = vectors(SEQUENCES);
        let mut messages = Messages::read();
        for row in rows(&file, "sequences") {
            check_sequence(row, &mut messages);
        }
    }

    #[test]
    fn every_carrier_equivalence_row_carries_the_same_bytes() {
        let file = vectors(CARRIER_EQUIVALENCE);
        for row in rows(&file, "rows") {
            let name = text(row, "name");
            let payload = text(row, "payload");
            assert_eq!(text(&row["abi"], "buffer"), hex(payload.as_bytes()), "{name}");

            let frame_bytes = unhex(text(&row["framed"], "frame"));
            let decoded = decode_frame(&frame_bytes).unwrap_or_else(|err| panic!("{name}: {err}"));
            assert_eq!(decoded.meta, text(&row["framed"], "meta"), "{name}");
            assert_eq!(decoded.envelope.message, text(row, "message"), "{name}");
            let carried = decode_typed_frame(&serde_json::to_string(&decoded.envelope.payload).unwrap());
            assert_eq!(encode_typed_frame(&carried.expect("the payload")).unwrap(), payload, "{name}");

            // The framed carrier adds its header and the envelope's other members,
            // and changes not one byte of the payload.
            let meta = text(&row["framed"], "meta");
            let offset = meta
                .find(payload)
                .unwrap_or_else(|| panic!("{name}: the meta does not carry the payload's own bytes"));
            let at = 9 + offset;
            assert_eq!(hex(&frame_bytes[at..at + payload.len()]), text(&row["abi"], "buffer"), "{name}");
            if let Some(chunk) = row["abi"].get("chunk") {
                assert_eq!(hex(&decoded.data), chunk.as_str().expect("chunk"), "{name}");
            }
        }
    }

    #[test]
    fn carrier_equivalence_covers_every_section() {
        let file = vectors(CARRIER_EQUIVALENCE);
        let messages = Messages::read();
        let sections: BTreeSet<&str> =
            messages.entries.values().map(|entry| entry["spec"].as_str().expect("spec")).collect();
        let covered: BTreeSet<&str> = rows(&file, "rows").iter().map(|row| text(row, "section")).collect();
        assert_eq!(covered, sections);
    }
}
