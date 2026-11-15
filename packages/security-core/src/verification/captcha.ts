import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** Characters that remain readable after distortion; 0/O and 1/I are excluded. */
export const CAPTCHA_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const FALLBACK_GLYPH: readonly string[] = [
  '01110',
  '10001',
  '10001',
  '11111',
  '10001',
  '10001',
  '10001',
];

const FONT: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

export interface CaptchaOptions {
  readonly length?: number;
  /** Number of noise lines and dots. Higher is harder to read. */
  readonly noise?: number;
  /** Deterministic source in [0, 1) for tests. */
  readonly rng?: () => number;
  /** Forces a known answer for tests. */
  readonly code?: string;
}

export interface CaptchaResult {
  readonly code: string;
  readonly png: Buffer;
}

/**
 * Generates a local, self-hosted CAPTCHA.
 *
 * This is a deterrent, not proof of humanity. Determined humans can solve it and
 * OCR can eventually read it, so it must always be layered with rate limits and
 * other anti-raid signals.
 */
export function generateCaptcha(options: CaptchaOptions = {}): CaptchaResult {
  const rng = options.rng ?? Math.random;
  const length = clamp(options.length ?? 6, 4, 10);
  const code = options.code ?? generateCode(length, rng);
  const png = renderCaptchaPng(code, {
    noise: options.noise ?? 3,
    rng,
  });

  return { code, png };
}

export function generateCode(length: number, rng: () => number = Math.random): string {
  const size = clamp(length, 4, 10);
  let code = '';

  for (let index = 0; index < size; index += 1) {
    code += CAPTCHA_ALPHABET[randomIndex(CAPTCHA_ALPHABET.length, rng)];
  }

  return code;
}

export function renderCaptchaPng(
  code: string,
  options: Omit<CaptchaOptions, 'length' | 'code'> = {},
): Buffer {
  const rng = options.rng ?? Math.random;
  const noise = clamp(options.noise ?? 3, 0, 12);
  const scale = 4;
  const characterWidth = 5 * scale;
  const spacing = 2 * scale;
  const padding = 3 * scale;
  const width = padding * 2 + code.length * characterWidth + Math.max(code.length - 1, 0) * spacing;
  const height = padding * 2 + 7 * scale;
  const pixels = new Uint8Array(width * height * 3);

  const background = 232 + Math.floor(rng() * 18);
  fill(pixels, width, height, background);

  // Random coloured lines behind and across the text.
  for (let index = 0; index < noise; index += 1) {
    const color = [
      40 + Math.floor(rng() * 130),
      40 + Math.floor(rng() * 130),
      40 + Math.floor(rng() * 130),
    ];
    drawLine(
      pixels,
      width,
      height,
      Math.floor(rng() * width),
      Math.floor(rng() * height),
      Math.floor(rng() * width),
      Math.floor(rng() * height),
      color,
    );
  }

  // Dots add high-frequency noise without hiding the glyphs.
  for (let index = 0; index < noise * 40; index += 1) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    setPixel(pixels, width, height, x, y, [90, 90, 90]);
  }

  for (let index = 0; index < code.length; index += 1) {
    const character = code[index] ?? 'A';
    const glyph = FONT[character] ?? FALLBACK_GLYPH;
    const baseX = padding + index * (characterWidth + spacing);
    const jitterY = Math.floor(rng() * 5) - 2;
    const color = [
      20 + Math.floor(rng() * 50),
      20 + Math.floor(rng() * 50),
      20 + Math.floor(rng() * 50),
    ];

    for (let row = 0; row < glyph.length; row += 1) {
      const line = glyph[row] ?? '';
      for (let column = 0; column < line.length; column += 1) {
        if (line[column] !== '1') {
          continue;
        }
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            setPixel(
              pixels,
              width,
              height,
              baseX + column * scale + dx,
              padding + row * scale + dy + jitterY,
              color,
            );
          }
        }
      }
    }
  }

  return encodePng(pixels, width, height);
}

export function hashAnswer(answer: string, salt?: string): string {
  const normalized = normalizeAnswer(answer);
  const actualSalt = salt ?? randomBytes(16).toString('hex');
  const derived = scryptSync(normalized, actualSalt, 32).toString('hex');
  return `${actualSalt}:${derived}`;
}

export function verifyAnswer(answer: string, storedHash: string): boolean {
  const [salt, expected] = storedHash.split(':');
  if (salt === undefined || expected === undefined) {
    return false;
  }

  try {
    const actual = scryptSync(normalizeAnswer(answer), salt, 32);
    const expectedBytes = Buffer.from(expected, 'hex');
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
  } catch {
    return false;
  }
}

export function normalizeAnswer(answer: string): string {
  return answer.trim().replace(/\s+/gu, '').toUpperCase();
}

function randomIndex(max: number, rng: () => number): number {
  if (rng === Math.random) {
    return randomInt(max);
  }
  return Math.min(max - 1, Math.floor(rng() * max));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function fill(pixels: Uint8Array, width: number, height: number, value: number): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(pixels, width, height, x, y, [value, value, value]);
    }
  }
}

function setPixel(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: readonly [number, number, number] | readonly number[],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const offset = (y * width + x) * 3;
  pixels[offset] = color[0] ?? 0;
  pixels[offset + 1] = color[1] ?? 0;
  pixels[offset + 2] = color[2] ?? 0;
}

function drawLine(
  pixels: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly number[],
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  let x = x0;
  let y = y0;

  for (let guard = 0; guard < width * height; guard += 1) {
    setPixel(pixels, width, height, x, y, color);
    if (x === x1 && y === y1) {
      return;
    }
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubled < dx) {
      error += dx;
      y += sy;
    }
  }
}

function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, rowOffset + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
