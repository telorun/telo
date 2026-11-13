//! Where a packaged application's payload lives inside its carrier, and how its presence
//! is found. Mirrors `../../../nodejs/src/package/app-trailer.ts`, `carriesPayload` only:
//! the payload is the `length` bytes before a 52-byte trailer ending in the magic, which
//! sits at the end of an ELF or PE file, in a Mach-O `TELO_APP` segment, or in a PE
//! resource. Nothing here reads or verifies the payload — this build cannot unpack one.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::package::pe_image::{read_pe_image, u32_le};
use crate::package::pe_resources::{find_resource, RT_RCDATA};

/// Ends the trailer, and says the bytes before it are a telo application.
const APP_MAGIC: &[u8; 8] = b"TELOAPP1";

/// `version` (u32) + `length` (u64) + sha256 (32) + magic (8).
const TRAILER_SIZE: usize = 4 + 8 + 32 + APP_MAGIC.len();

/// The Mach-O segment the payload rides in, and the section inside it.
const MACHO_SEGMENT: &str = "TELO_APP";
const MACHO_SECTION: &str = "TELO_APP_PAYLOAD";
/// The `RT_RCDATA` resource name the payload rides under in a PE resource.
const PE_PAYLOAD_RESOURCE: &str = "TELO_APP_PAYLOAD";

const MH_MAGIC_64: u32 = 0xfeed_facf;
const MH_CIGAM_64: u32 = 0xcffa_edfe;
const FAT_MAGIC: u32 = 0xcafe_babe;
const LC_SEGMENT_64: u32 = 0x19;
const MACHO_HEADER_SIZE: usize = 32;
const SEGMENT_COMMAND_SIZE: usize = 72;
const SECTION_SIZE: usize = 80;

fn read_at(file: &mut File, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(length);
    file.take(length as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Whether the last `TRAILER_SIZE` bytes of `tail` end in the magic.
fn ends_in_magic(tail: &[u8]) -> bool {
    tail.len() >= TRAILER_SIZE && tail[tail.len() - APP_MAGIC.len()..] == APP_MAGIC[..]
}

/// Whether `file` carries a telo application — its trailer or segment, found without
/// reading or verifying the payload. `Err` is a message Node reports for the same file: a
/// universal or big-endian Mach-O, which telo does not read a payload out of, or a file
/// that cannot be read.
pub fn carries_payload(file: &Path) -> Result<bool, String> {
    let unreadable = |err: std::io::Error| format!("cannot read {}: {err}", file.display());
    let mut handle = File::open(file).map_err(unreadable)?;
    let size = handle.metadata().map_err(unreadable)?.len();
    if size < TRAILER_SIZE as u64 {
        return Ok(false);
    }
    let tail = read_at(&mut handle, size - TRAILER_SIZE as u64, TRAILER_SIZE).map_err(unreadable)?;
    if ends_in_magic(&tail) {
        return Ok(true);
    }
    if let Some((offset, section_size)) = macho_section(&mut handle, size)? {
        if section_size < TRAILER_SIZE as u64 {
            return Ok(false);
        }
        let section_tail =
            read_at(&mut handle, offset + section_size - TRAILER_SIZE as u64, TRAILER_SIZE).map_err(unreadable)?;
        return Ok(ends_in_magic(&section_tail));
    }
    let mut reader = |offset: u64, length: usize| {
        let length = length.min(size.saturating_sub(offset) as usize);
        read_at(&mut handle, offset, length)
    };
    let Some(image) = read_pe_image(&mut reader, size).map_err(unreadable)? else { return Ok(false) };
    let Some(resource) =
        find_resource(&mut reader, &image, RT_RCDATA, PE_PAYLOAD_RESOURCE).map_err(unreadable)?
    else {
        return Ok(false);
    };
    if resource.size < TRAILER_SIZE as u64 {
        return Ok(false);
    }
    let resource_tail =
        reader(resource.offset + resource.size - TRAILER_SIZE as u64, TRAILER_SIZE).map_err(unreadable)?;
    Ok(ends_in_magic(&resource_tail))
}

/// The `TELO_APP,TELO_APP_PAYLOAD` section of a 64-bit little-endian Mach-O, as its file
/// offset and size. Only that one shape is read: a universal binary is something no
/// carrier is, and is reported rather than guessed at.
fn macho_section(handle: &mut File, size: u64) -> Result<Option<(u64, u64)>, String> {
    let unreadable = |err: std::io::Error| format!("cannot read the executable: {err}");
    let header = read_at(handle, 0, MACHO_HEADER_SIZE).map_err(unreadable)?;
    if header.len() < MACHO_HEADER_SIZE {
        return Ok(None);
    }
    let magic = u32_le(&header, 0);
    if magic == FAT_MAGIC || u32::from_be_bytes([header[0], header[1], header[2], header[3]]) == FAT_MAGIC {
        return Err("this executable is a universal (fat) Mach-O binary, which telo does not package into or read a payload out of.".to_string());
    }
    if magic != MH_MAGIC_64 && magic != MH_CIGAM_64 {
        return Ok(None);
    }
    if magic == MH_CIGAM_64 {
        return Err("this executable is a big-endian Mach-O binary, which telo does not read.".to_string());
    }
    let ncmds = u32_le(&header, 16) as usize;
    let sizeofcmds = u32_le(&header, 20) as usize;
    if sizeofcmds == 0 || (MACHO_HEADER_SIZE + sizeofcmds) as u64 > size {
        return Ok(None);
    }
    let commands = read_at(handle, MACHO_HEADER_SIZE as u64, sizeofcmds).map_err(unreadable)?;
    let mut at = 0;
    for _ in 0..ncmds {
        if at + 8 > sizeofcmds {
            break;
        }
        let cmd = u32_le(&commands, at);
        let cmdsize = u32_le(&commands, at + 4) as usize;
        if cmdsize < 8 || at + cmdsize > sizeofcmds {
            return Ok(None);
        }
        if cmd == LC_SEGMENT_64 && cmdsize >= SEGMENT_COMMAND_SIZE && c_string(&commands, at + 8, 16) == MACHO_SEGMENT {
            let nsects = u32_le(&commands, at + 64) as usize;
            for s in 0..nsects {
                let section = at + SEGMENT_COMMAND_SIZE + s * SECTION_SIZE;
                if section + SECTION_SIZE > sizeofcmds {
                    return Ok(None);
                }
                if c_string(&commands, section, 16) != MACHO_SECTION {
                    continue;
                }
                let section_size = u64::from_le_bytes(commands[section + 40..section + 48].try_into().expect("8 bytes"));
                return Ok(Some((u64::from(u32_le(&commands, section + 48)), section_size)));
            }
        }
        at += cmdsize;
    }
    Ok(None)
}

/// A fixed-width Mach-O name field, which pads with NULs and does not terminate a name
/// that fills the field.
fn c_string(bytes: &[u8], at: usize, width: usize) -> String {
    let raw = &bytes[at..at + width];
    let end = raw.iter().position(|b| *b == 0).unwrap_or(width);
    raw[..end].iter().map(|b| *b as char).collect()
}
