//! The headers of a PE image (a Windows executable): the section table and the data
//! directories, read without reading the image itself. Mirrors
//! `../../../nodejs/src/package/pe-image.ts`; this twin only reads — nothing here writes
//! an image, since `telo package` is not part of this build.

/// Reads up to `length` bytes at `offset`; fewer at the end of the file.
pub type ReadAt<'a> = dyn FnMut(u64, usize) -> std::io::Result<Vec<u8>> + 'a;

const DOS_MAGIC: u16 = 0x5a4d;
const PE_SIGNATURE: u32 = 0x0000_4550;
const PE32_MAGIC: u16 = 0x10b;
const PE32_PLUS_MAGIC: u16 = 0x20b;
const SECTION_HEADER_SIZE: usize = 40;
const COFF_HEADER_SIZE: usize = 20;

/// The resource data directory's index.
const DIRECTORY_RESOURCE: usize = 2;

#[derive(Debug, Clone)]
pub struct PeSection {
    pub virtual_address: u32,
    pub size_of_raw_data: u32,
    pub pointer_to_raw_data: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct PeDirectory {
    pub rva: u32,
    pub size: u32,
}

#[derive(Debug, Clone)]
pub struct PeImage {
    pub directories: Vec<PeDirectory>,
    pub sections: Vec<PeSection>,
}

pub fn u16_le(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

pub fn u32_le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The PE headers of a file, or `None` for one that is not a PE image.
pub fn read_pe_image(read_at: &mut ReadAt, file_size: u64) -> std::io::Result<Option<PeImage>> {
    let dos = read_at(0, 64)?;
    if dos.len() < 64 || u16_le(&dos, 0) != DOS_MAGIC {
        return Ok(None);
    }
    let pe_offset = u64::from(u32_le(&dos, 60));
    if pe_offset + 4 + COFF_HEADER_SIZE as u64 > file_size {
        return Ok(None);
    }
    let coff = read_at(pe_offset, 4 + COFF_HEADER_SIZE)?;
    if coff.len() < 4 + COFF_HEADER_SIZE || u32_le(&coff, 0) != PE_SIGNATURE {
        return Ok(None);
    }
    let section_count = usize::from(u16_le(&coff, 6));
    let optional_size = usize::from(u16_le(&coff, 20));
    let optional_offset = pe_offset + 4 + COFF_HEADER_SIZE as u64;
    let optional = read_at(optional_offset, optional_size)?;
    if optional.len() < optional_size || optional_size < 2 {
        return Ok(None);
    }
    let count_at = match u16_le(&optional, 0) {
        PE32_PLUS_MAGIC => 108,
        PE32_MAGIC => 92,
        _ => return Ok(None),
    };
    if optional_size < count_at + 4 {
        return Ok(None);
    }
    let directory_count = (u32_le(&optional, count_at) as usize).min((optional_size - count_at - 4) / 8);
    let directories = (0..directory_count)
        .map(|i| PeDirectory {
            rva: u32_le(&optional, count_at + 4 + i * 8),
            size: u32_le(&optional, count_at + 8 + i * 8),
        })
        .collect();
    let table = read_at(optional_offset + optional_size as u64, section_count * SECTION_HEADER_SIZE)?;
    if table.len() < section_count * SECTION_HEADER_SIZE {
        return Ok(None);
    }
    let sections = (0..section_count)
        .map(|i| {
            let at = i * SECTION_HEADER_SIZE;
            PeSection {
                virtual_address: u32_le(&table, at + 12),
                size_of_raw_data: u32_le(&table, at + 16),
                pointer_to_raw_data: u32_le(&table, at + 20),
            }
        })
        .collect();
    Ok(Some(PeImage { directories, sections }))
}

impl PeImage {
    /// The section holding `rva` in its file bytes.
    pub fn section_of(&self, rva: u32) -> Option<&PeSection> {
        self.sections
            .iter()
            .find(|s| rva >= s.virtual_address && u64::from(rva) < u64::from(s.virtual_address) + u64::from(s.size_of_raw_data))
    }

    /// The file offset of `rva`, when its bytes are in the file.
    pub fn file_offset_of(&self, rva: u32) -> Option<u64> {
        let section = self.section_of(rva)?;
        Some(u64::from(section.pointer_to_raw_data) + u64::from(rva - section.virtual_address))
    }

    pub fn resource_directory(&self) -> Option<PeDirectory> {
        self.directories.get(DIRECTORY_RESOURCE).copied()
    }
}
