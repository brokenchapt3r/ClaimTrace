import { createHash } from 'node:crypto';

export type TextChunk = {
  content: string;
  ordinal: number;
  charStart: number;
  charEnd: number;
  hash: string;
};

const minimumLength = 120;
const maximumLength = 320;

function semanticUnits(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？!?；;])|\n{2,}/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

// Short neighboring sentences remain together to preserve conditions and exceptions. Oversized
// units are split at the hard upper bound so offsets remain deterministic and replayable.
export function chunkDocument(input: string): TextChunk[] {
  const normalized = input.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];
  const contents: string[] = [];
  let buffer = '';
  const push = (content: string) => content.trim() && contents.push(content.trim());

  for (const unit of semanticUnits(normalized)) {
    if (unit.length > maximumLength) {
      if (buffer) {
        push(buffer);
        buffer = '';
      }
      for (let offset = 0; offset < unit.length; offset += maximumLength) {
        push(unit.slice(offset, offset + maximumLength));
      }
      continue;
    }
    if (buffer && buffer.length + unit.length > maximumLength) {
      push(buffer);
      buffer = unit;
    } else {
      buffer += unit;
    }
    if (buffer.length >= minimumLength) {
      push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    const previous = contents.at(-1);
    if (previous && buffer.length < minimumLength && previous.length + buffer.length <= maximumLength) {
      contents[contents.length - 1] = `${previous}${buffer}`;
    } else push(buffer);
  }
  let searchOffset = 0;
  return contents.map((content, index) => {
    const located = normalized.indexOf(content, searchOffset);
    const charStart = located >= 0 ? located : searchOffset;
    searchOffset = charStart + content.length;
    return {
      content,
      ordinal: index,
      charStart,
      charEnd: searchOffset,
      hash: createHash('sha256').update(content).digest('hex'),
    };
  });
}
