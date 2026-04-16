export interface ChunkerOptions {
  target?: number;
  minSize?: number;
  overlap?: number;
  headings?: string[];
}

export interface ChunkResult {
  index: number;
  text: string;
  isContinuation: boolean;
}

const DEFAULT_TARGET = 1500;
const DEFAULT_MIN_SIZE = 200;
const DEFAULT_OVERLAP = 150;

export function chunkText(text: string, options?: ChunkerOptions): ChunkResult[] {
  const target = options?.target ?? DEFAULT_TARGET;
  const minSize = options?.minSize ?? DEFAULT_MIN_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;
  const headings = options?.headings;

  const trimmed = text.trim();
  if (!trimmed) return [];

  // Split on paragraph boundaries (blank lines)
  let segments = trimmed.split(/\n\s*\n/).filter((s) => s.trim().length > 0);

  // Merge segments that are too small to stand alone
  segments = mergeUndersized(segments, minSize);

  // Build chunks by packing segments up to target size
  const rawChunks = buildChunks(segments, target);

  // Split any oversized chunks at sentence boundaries
  const splitChunks = rawChunks.flatMap((c) =>
    c.length > target * 1.5 ? splitAtSentences(c, target) : [c]
  );

  // Apply overlap from previous chunk
  const overlapped = applyOverlap(splitChunks, overlap);

  // Build breadcrumb prefix from headings
  const breadcrumb = headings?.length ? headings.join(" > ") : null;

  return overlapped.map((text, i) => ({
    index: i,
    text: breadcrumb ? `${breadcrumb}\n\n${text}` : text,
    isContinuation: i > 0,
  }));
}

function mergeUndersized(segments: string[], minSize: number): string[] {
  if (segments.length <= 1) return segments;
  const result: string[] = [];
  let buffer = segments[0];

  for (let i = 1; i < segments.length; i++) {
    if (buffer.length < minSize || segments[i].length < minSize) {
      buffer = buffer + "\n\n" + segments[i];
    } else {
      result.push(buffer);
      buffer = segments[i];
    }
  }
  if (buffer) result.push(buffer);
  return result;
}

function buildChunks(segments: string[], target: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const seg of segments) {
    const addedLen = seg.length + (current.length > 0 ? 2 : 0); // 2 for "\n\n"
    if (current.length > 0 && currentLen + addedLen > target) {
      chunks.push(current.join("\n\n"));
      current = [seg];
      currentLen = seg.length;
    } else {
      current.push(seg);
      currentLen += addedLen;
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }
  return chunks;
}

function splitAtSentences(text: string, target: number): string[] {
  // Split after sentence-ending punctuation (English and Chinese)
  const sentences = text.split(/(?<=[.。!！?？\n])\s*/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (current && current.length + sentence.length > target) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + " " + sentence : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

function applyOverlap(chunks: string[], overlap: number): string[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const result = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prevText = chunks[i - 1];
    const overlapText = prevText.slice(-overlap);
    result.push(overlapText + chunks[i]);
  }
  return result;
}
