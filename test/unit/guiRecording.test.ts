import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { expect, test } from 'vitest';

import { GuiRecorder, MAX_GUI_RECORDING_BYTES } from '../../packages/problem-utils/src/helpers/guiRecording.js';

interface Chunk {
  type: string;
  data: Buffer;
}

test('records a changing window as an animated PNG that shows each capture for as long as it lasted', () => {
  const recorder = new GuiRecorder();
  recorder.add('1', { path: 'Ball_1.png', data: createPng(4, 4, 0x10) }, 1000);
  recorder.add('1', { path: 'Ball_1.png', data: createPng(4, 4, 0x20) }, 1300);
  recorder.add('1', { path: 'Ball_1.png', data: createPng(4, 4, 0x20) }, 1600);
  recorder.add('1', { path: 'Ball_1.png', data: createPng(4, 4, 0x30) }, 2000);

  const recordings = recorder.build(300);

  expect(recordings.map((recording) => recording.path)).toEqual(['Ball_1_recording.png']);
  const chunks = readChunks(recordings[0]?.data ?? '');
  expect(chunks.map((chunk) => chunk.type)).toEqual([
    'IHDR',
    'acTL',
    'fcTL',
    'IDAT',
    'fcTL',
    'fdAT',
    'fcTL',
    'fdAT',
    'IEND',
  ]);
  expect(readFrameCountAndPlayCount(chunks)).toEqual([3, 0]);
  expect(readFrameDelaysMs(chunks)).toEqual([300, 700, 300]);
  // Frame data is numbered in display order together with the frame controls.
  expect(readSequenceNumbers(chunks)).toEqual([0, 1, 2, 3, 4]);
});

test('leaves out a window that only appeared and was painted', () => {
  const recorder = new GuiRecorder();
  for (const capturedAtMs of [1000, 1300, 1600]) {
    recorder.add('1', { path: 'Still_1.png', data: createPng(4, 4, capturedAtMs === 1000 ? 0 : 0x10) }, capturedAtMs);
    recorder.add('2', { path: 'Ball_2.png', data: createPng(4, 4, capturedAtMs % 256) }, capturedAtMs);
  }

  expect(recorder.build(300).map((recording) => recording.path)).toEqual(['Ball_2_recording.png']);
});

test('keeps a window that changes its size on a canvas fitting every frame', () => {
  const recorder = new GuiRecorder();
  recorder.add('1', { path: 'Window_1.png', data: createPng(2, 6, 0x10) }, 1000);
  recorder.add('1', { path: 'Window_1.png', data: createPng(8, 4, 0x20) }, 1300);
  recorder.add('1', { path: 'Window_1.png', data: createPng(8, 4, 0x30) }, 1600);

  const chunks = readChunks(recorder.build(300)[0]?.data ?? '');

  const header = chunks[0]?.data;
  expect([header?.readUInt32BE(0), header?.readUInt32BE(4)]).toEqual([8, 6]);
  // No frame fills the canvas, so a blank image stands in for viewers without animation support.
  expect(chunks.map((chunk) => chunk.type)).toEqual([
    'IHDR',
    'acTL',
    'IDAT',
    'fcTL',
    'fdAT',
    'fcTL',
    'fdAT',
    'fcTL',
    'fdAT',
    'IEND',
  ]);
  expect(zlib.inflateSync(chunks[2]?.data ?? Buffer.alloc(0))).toHaveLength(6 * (1 + 8 * 3));
});

test('drops frames until the recordings of a run fit the size limit', () => {
  const recorder = new GuiRecorder();
  const frameCount = 12;
  for (let index = 0; index < frameCount; index++) {
    // Random pixels do not compress, so every frame takes about a quarter of the limit.
    recorder.add('1', { path: 'Noise_1.png', data: createPng(700, 250, undefined) }, 1000 + index * 300);
  }

  const [recording] = recorder.build(300);

  const chunks = readChunks(recording?.data ?? '');
  expect(Buffer.from(recording?.data ?? '', 'base64').length).toBeLessThanOrEqual(MAX_GUI_RECORDING_BYTES);
  expect(readFrameCountAndPlayCount(chunks)[0]).toBe(3);
  // The remaining frames still span the whole run.
  expect(readFrameDelaysMs(chunks).reduce((sum, delayMs) => sum + delayMs, 0)).toBe(frameCount * 300);
});

/** Creates an RGB image filled with the given byte, or with random bytes when it is undefined. */
function createPng(width: number, height: number, fill: number | undefined): string {
  const scanlines =
    fill === undefined ? crypto.randomBytes(height * (1 + width * 3)) : Buffer.alloc(height * (1 + width * 3), fill);
  // Every scanline starts with filter type 0 (none).
  for (let y = 0; y < height; y++) scanlines[y * (1 + width * 3)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    createChunk('IHDR', header),
    createChunk('IDAT', zlib.deflateSync(scanlines)),
    createChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function createChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

/** Reads the chunks of a PNG file, failing on a chunk whose checksum does not match. */
function readChunks(base64: string): Chunk[] {
  const png = Buffer.from(base64, 'base64');
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const typeAndData = png.subarray(offset + 4, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(zlib.crc32(typeAndData));
    chunks.push({ type: typeAndData.toString('latin1', 0, 4), data: typeAndData.subarray(4) });
    offset += 12 + length;
  }
  return chunks;
}

function readFrameCountAndPlayCount(chunks: readonly Chunk[]): number[] {
  const animationControl = chunks.find((chunk) => chunk.type === 'acTL')?.data ?? Buffer.alloc(8);
  return [animationControl.readUInt32BE(0), animationControl.readUInt32BE(4)];
}

function readFrameDelaysMs(chunks: readonly Chunk[]): number[] {
  return chunks
    .filter((chunk) => chunk.type === 'fcTL')
    .map((chunk) => (chunk.data.readUInt16BE(20) / chunk.data.readUInt16BE(22)) * 1000);
}

function readSequenceNumbers(chunks: readonly Chunk[]): number[] {
  return chunks
    .filter((chunk) => chunk.type === 'fcTL' || chunk.type === 'fdAT')
    .map((chunk) => chunk.data.readUInt32BE(0));
}
