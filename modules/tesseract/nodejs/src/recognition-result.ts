/**
 * Tesseract's JSON result, turned into the contract's shape: flat block, line
 * and word lists linked by index, confidences from 0 to 1, and every element's
 * box plus its four corners.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface RecognizedElement {
  text: string;
  confidence: number;
  box: Box;
  polygon: Point[];
}

export interface Orientation {
  degrees: number;
  script: string;
  confidence: number;
}

export interface RecognizedPage {
  text: string;
  confidence: number;
  blocks: RecognizedElement[];
  lines: (RecognizedElement & { block: number })[];
  words: (RecognizedElement & { line: number })[];
  orientation?: Orientation;
  hocr?: string;
  tsv?: string;
}

interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TesseractElement {
  bbox: TesseractBox;
  text: string;
  confidence: number;
}

/** The part of `GetJSONText`'s output this reads. */
export interface TesseractJson {
  blocks?: (TesseractElement & {
    paragraphs?: { lines?: (TesseractElement & { words?: TesseractElement[] })[] }[];
  })[];
}

/**
 * `blockOrientations[i]` is the engine's orientation of the i-th JSON block
 * (0 up, 1 right, 2 down, 3 left — where the top of the text points), which
 * decides the polygon's first corner. A block with no words is dropped, and so
 * is a line with none.
 */
export function pageFromTesseract(
  json: TesseractJson,
  blockOrientations: readonly number[],
): Pick<RecognizedPage, "text" | "confidence" | "blocks" | "lines" | "words"> {
  const blocks: RecognizedPage["blocks"] = [];
  const lines: RecognizedPage["lines"] = [];
  const words: RecognizedPage["words"] = [];
  const blockTexts: string[] = [];

  (json.blocks ?? []).forEach((block, blockAt) => {
    const orientation = blockOrientations[blockAt] ?? 0;
    const blockLines: string[] = [];
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const lineWords = (line.words ?? []).filter((word) => word.text.trim() !== "");
        if (lineWords.length === 0) continue;
        const lineIndex = lines.length;
        const lineText = line.text.replace(/\s+$/, "");
        lines.push({ ...element(line, lineText, orientation), block: blocks.length });
        blockLines.push(lineText);
        for (const word of lineWords) {
          words.push({ ...element(word, word.text, orientation), line: lineIndex });
        }
      }
    }
    if (blockLines.length === 0) return;
    const blockText = blockLines.join("\n");
    blocks.push(element(block, blockText, orientation));
    blockTexts.push(blockText);
  });

  const confidence =
    words.length === 0 ? 0 : words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
  return { text: blockTexts.join("\n\n"), confidence, blocks, lines, words };
}

function element(source: TesseractElement, text: string, orientation: number): RecognizedElement {
  const x0 = Math.max(0, source.bbox.x0);
  const y0 = Math.max(0, source.bbox.y0);
  const x1 = Math.max(x0, source.bbox.x1);
  const y1 = Math.max(y0, source.bbox.y1);
  // Clockwise on the image, starting at the corner the text's top-left sits on.
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const start = ((orientation % 4) + 4) % 4;
  return {
    text,
    confidence: Math.min(1, Math.max(0, source.confidence / 100)),
    box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    polygon: [...corners.slice(start), ...corners.slice(0, start)],
  };
}
