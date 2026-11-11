//! PNG icons to the RGBA pixels the toolkit takes. The decoding is plain Rust; only
//! handing the pixels to a window or tray icon needs the native toolkit.
//!
//! No Node twin: this crate has none (see `lib.rs`).

use std::io::Cursor;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, 8 bits per channel, straight alpha.
    pub pixels: Vec<u8>,
}

pub fn read_png(path: &Path) -> Result<Rgba, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    decode_png(&bytes).map_err(|e| format!("{} is not a usable PNG: {e}", path.display()))
}

pub fn decode_png(bytes: &[u8]) -> Result<Rgba, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    // Palette and low bit depths expanded, 16-bit samples reduced to 8.
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader.output_buffer_size().ok_or("the image is too large to decode")?;
    let mut buffer = vec![0u8; size];
    let frame = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    let data = &buffer[..frame.buffer_size()];
    let (width, height) = (frame.width, frame.height);
    let pixels = match frame.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => data.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Indexed => return Err("an indexed image was not expanded".into()),
    };
    Ok(Rgba { width, height, pixels })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(color: png::ColorType, depth: png::BitDepth, width: u32, height: u32, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(color);
        encoder.set_depth(depth);
        encoder.write_header().unwrap().write_image_data(data).unwrap();
        out
    }

    #[test]
    fn reads_rgba_unchanged() {
        let data = [1, 2, 3, 4, 5, 6, 7, 8];
        let png = encode(png::ColorType::Rgba, png::BitDepth::Eight, 2, 1, &data);
        assert_eq!(decode_png(&png).unwrap(), Rgba { width: 2, height: 1, pixels: data.to_vec() });
    }

    #[test]
    fn widens_rgb_gray_and_gray_alpha_to_rgba() {
        let rgb = encode(png::ColorType::Rgb, png::BitDepth::Eight, 1, 1, &[9, 8, 7]);
        assert_eq!(decode_png(&rgb).unwrap().pixels, [9, 8, 7, 255]);
        let gray = encode(png::ColorType::Grayscale, png::BitDepth::Eight, 1, 1, &[40]);
        assert_eq!(decode_png(&gray).unwrap().pixels, [40, 40, 40, 255]);
        let gray_alpha = encode(png::ColorType::GrayscaleAlpha, png::BitDepth::Eight, 1, 1, &[40, 128]);
        assert_eq!(decode_png(&gray_alpha).unwrap().pixels, [40, 40, 40, 128]);
    }

    #[test]
    fn reduces_sixteen_bit_samples_to_eight() {
        let png = encode(png::ColorType::Rgb, png::BitDepth::Sixteen, 1, 1, &[0xAB, 0xCD, 0x12, 0x34, 0xFF, 0x00]);
        assert_eq!(decode_png(&png).unwrap().pixels, [0xAB, 0x12, 0xFF, 255]);
    }

    #[test]
    fn a_file_that_is_not_a_png_is_refused_with_its_path() {
        assert!(decode_png(b"GIF89a").is_err());
        let error = read_png(Path::new("/definitely/not/here.png")).unwrap_err();
        assert!(error.contains("/definitely/not/here.png"));
    }
}
