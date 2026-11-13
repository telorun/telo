//! A PE image's resources: the three-level directory tree (type, name, language) the
//! Windows loader's `FindResource` walks. Mirrors `../../../nodejs/src/package/pe-resources.ts`,
//! reading only: reading is bounded to the section the tree lives in, and a tree that
//! leaves it or nests deeper than three levels is not one, answered as `None`.

use crate::package::pe_image::{u16_le, u32_le, PeImage, ReadAt};

/// An integer id, or a name (stored as written).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceKey {
    Id(u16),
    Name(String),
}

pub const RT_RCDATA: u16 = 10;

/// Where one resource's bytes are.
#[derive(Debug, Clone, Copy)]
pub struct ResourceLocation {
    /// File offset of the data.
    pub offset: u64,
    pub size: u64,
}

const SUBDIRECTORY: u32 = 0x8000_0000;
const DIRECTORY_HEADER_SIZE: usize = 16;
const DIRECTORY_ENTRY_SIZE: usize = 8;
const DATA_ENTRY_SIZE: usize = 16;
/// Ids and names one directory may list, far above anything a linker writes.
const MAX_DIRECTORY_ENTRIES: usize = 0x10000;

struct DirectoryEntry {
    key: ResourceKey,
    subdirectory: bool,
    /// Relative to the tree's root.
    offset: usize,
}

struct Tree<'a, 'b> {
    read_at: &'a mut ReadAt<'b>,
    image: &'a PeImage,
    /// File offset of the root directory.
    root: u64,
    /// How many bytes past the root the tree may address: the rest of its section.
    extent: usize,
}

fn open_tree<'a, 'b>(read_at: &'a mut ReadAt<'b>, image: &'a PeImage) -> Option<Tree<'a, 'b>> {
    let directory = image.resource_directory().filter(|d| d.size != 0 && d.rva != 0)?;
    let section = image.section_of(directory.rva)?;
    let root = image.file_offset_of(directory.rva)?;
    let end = u64::from(section.pointer_to_raw_data) + u64::from(section.size_of_raw_data);
    Some(Tree { read_at, image, root, extent: end.checked_sub(root)? as usize })
}

impl Tree<'_, '_> {
    fn read(&mut self, at: usize, length: usize) -> std::io::Result<Vec<u8>> {
        (self.read_at)(self.root + at as u64, length)
    }

    fn read_directory(&mut self, at: usize) -> std::io::Result<Option<Vec<DirectoryEntry>>> {
        if at + DIRECTORY_HEADER_SIZE > self.extent {
            return Ok(None);
        }
        let header = self.read(at, DIRECTORY_HEADER_SIZE)?;
        if header.len() < DIRECTORY_HEADER_SIZE {
            return Ok(None);
        }
        let count = usize::from(u16_le(&header, 12)) + usize::from(u16_le(&header, 14));
        if count > MAX_DIRECTORY_ENTRIES || at + DIRECTORY_HEADER_SIZE + count * DIRECTORY_ENTRY_SIZE > self.extent {
            return Ok(None);
        }
        let raw = self.read(at + DIRECTORY_HEADER_SIZE, count * DIRECTORY_ENTRY_SIZE)?;
        if raw.len() < count * DIRECTORY_ENTRY_SIZE {
            return Ok(None);
        }
        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let name = u32_le(&raw, i * DIRECTORY_ENTRY_SIZE);
            let target = u32_le(&raw, i * DIRECTORY_ENTRY_SIZE + 4);
            let key = if name & SUBDIRECTORY != 0 {
                match self.read_name((name & !SUBDIRECTORY) as usize)? {
                    Some(named) => ResourceKey::Name(named),
                    None => return Ok(None),
                }
            } else {
                ResourceKey::Id((name & 0xffff) as u16)
            };
            entries.push(DirectoryEntry {
                key,
                subdirectory: target & SUBDIRECTORY != 0,
                offset: (target & !SUBDIRECTORY) as usize,
            });
        }
        Ok(Some(entries))
    }

    fn read_name(&mut self, at: usize) -> std::io::Result<Option<String>> {
        if at + 2 > self.extent {
            return Ok(None);
        }
        let length = usize::from(u16_le(&self.read(at, 2)?, 0));
        if at + 2 + length * 2 > self.extent {
            return Ok(None);
        }
        let bytes = self.read(at + 2, length * 2)?;
        let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        Ok(Some(String::from_utf16_lossy(&units)))
    }

    fn read_data_entry(&mut self, at: usize) -> std::io::Result<Option<ResourceLocation>> {
        if at + DATA_ENTRY_SIZE > self.extent {
            return Ok(None);
        }
        let raw = self.read(at, DATA_ENTRY_SIZE)?;
        if raw.len() < DATA_ENTRY_SIZE {
            return Ok(None);
        }
        let rva = u32_le(&raw, 0);
        let size = u32_le(&raw, 4);
        let Some(section) = self.image.section_of(rva) else { return Ok(None) };
        if u64::from(rva) + u64::from(size) > u64::from(section.virtual_address) + u64::from(section.size_of_raw_data) {
            return Ok(None);
        }
        Ok(Some(ResourceLocation {
            offset: u64::from(section.pointer_to_raw_data) + u64::from(rva - section.virtual_address),
            size: u64::from(size),
        }))
    }
}

/// Where the first language of resource `type_id`/`name` is, or `None` when the image has
/// no such resource or no readable tree.
pub fn find_resource(
    read_at: &mut ReadAt,
    image: &PeImage,
    type_id: u16,
    name: &str,
) -> std::io::Result<Option<ResourceLocation>> {
    let Some(mut tree) = open_tree(read_at, image) else { return Ok(None) };
    let Some(types) = tree.read_directory(0)? else { return Ok(None) };
    let Some(type_entry) = types.iter().find(|e| e.key == ResourceKey::Id(type_id) && e.subdirectory) else {
        return Ok(None);
    };
    let Some(names) = tree.read_directory(type_entry.offset)? else { return Ok(None) };
    let Some(name_entry) = names.iter().find(|e| e.key == ResourceKey::Name(name.to_string()) && e.subdirectory)
    else {
        return Ok(None);
    };
    let Some(languages) = tree.read_directory(name_entry.offset)? else { return Ok(None) };
    let Some(language) = languages.first().filter(|l| !l.subdirectory) else { return Ok(None) };
    tree.read_data_entry(language.offset)
}
