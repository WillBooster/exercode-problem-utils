import zlib from 'node:zlib';

/** Bounds the recordings of one GUI run in total, so a judge server can budget for them. */
export const MAX_GUI_RECORDING_BYTES = 2 * 1024 * 1024;

export interface GuiRecordingFile {
  path: string;
  data: string;
  encoding: 'base64';
}

interface CapturedFrame {
  /** A PNG image in base64. */
  data: string;
  capturedAtMs: number;
}

interface WindowCaptures {
  path: string;
  frames: CapturedFrame[];
  lastSeenAtMs: number;
}

interface AnimationFrame {
  png: Buffer;
  delayMs: number;
}

interface ParsedPng {
  /** The IHDR data: width, height, and the 5-byte pixel format. */
  header: Buffer;
  /** The chunks between IHDR and the image data (e.g. a palette), as they are in the file. */
  metadataChunks: Buffer[];
  imageData: Buffer;
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_UINT16 = 65_535;
// A window is typically captured blank once before its first paint, which is not an animation.
const MIN_RECORDED_FRAME_COUNT = 3;

/**
 * Collects the screenshots of each window over a run and turns the windows that kept changing into
 * animated PNGs, which browsers play wherever they show a PNG.
 */
export class GuiRecorder {
  readonly #windowIdToCaptures = new Map<string, WindowCaptures>();

  add(windowId: string, screenshot: { path: string; data: string }, capturedAtMs: number): void {
    const captures = this.#windowIdToCaptures.get(windowId) ?? { path: '', frames: [], lastSeenAtMs: 0 };
    this.#windowIdToCaptures.set(windowId, captures);
    captures.path = screenshot.path.replace(/\.png$/, '_recording.png');
    captures.lastSeenAtMs = capturedAtMs;
    // An unchanged window only extends how long its last frame is shown.
    if (captures.frames.at(-1)?.data !== screenshot.data) {
      captures.frames.push({ data: screenshot.data, capturedAtMs });
    }
  }

  /** @param frameIntervalMs How long the last capture of a window is shown. */
  build(frameIntervalMs: number): GuiRecordingFile[] {
    const animatedCaptures = [...this.#windowIdToCaptures.values()].filter(
      (captures) => captures.frames.length >= MIN_RECORDED_FRAME_COUNT
    );
    const recordings = animatedCaptures.map(({ path, frames: capturedFrames, lastSeenAtMs }) => {
      const frames: AnimationFrame[] = capturedFrames.map((frame, index) => ({
        png: Buffer.from(frame.data, 'base64'),
        delayMs: (capturedFrames[index + 1]?.capturedAtMs ?? lastSeenAtMs + frameIntervalMs) - frame.capturedAtMs,
      }));
      return { path, frames, animatedPng: encodeAnimatedPng(frames) };
    });

    // Shrink the largest recording that can still lose frames until all of them fit together; one
    // that does not fit even with two frames is left out.
    while (recordings.reduce((sum, recording) => sum + recording.animatedPng.length, 0) > MAX_GUI_RECORDING_BYTES) {
      const bySizeDescending = recordings.toSorted((a, b) => b.animatedPng.length - a.animatedPng.length);
      const shrinkable = bySizeDescending.find((recording) => recording.frames.length > 2);
      if (shrinkable) {
        shrinkable.frames = dropEveryOtherFrame(shrinkable.frames);
        shrinkable.animatedPng = encodeAnimatedPng(shrinkable.frames);
      } else {
        recordings.splice(recordings.indexOf(bySizeDescending[0] as (typeof recordings)[number]), 1);
      }
    }
    return recordings.map(({ path, animatedPng }) => ({
      path,
      data: animatedPng.toString('base64'),
      encoding: 'base64',
    }));
  }
}

function dropEveryOtherFrame(frames: readonly AnimationFrame[]): AnimationFrame[] {
  const keptFrames: AnimationFrame[] = [];
  for (const [index, frame] of frames.entries()) {
    const keptFrame = keptFrames.at(-1);
    if (index % 2 === 0 || !keptFrame) {
      keptFrames.push({ ...frame });
    } else {
      keptFrame.delayMs += frame.delayMs;
    }
  }
  return keptFrames;
}

/**
 * Assembles PNG images into an animated PNG (APNG) that loops forever. The compressed image data of
 * each frame is reused as is, so the frames must share the pixel format of the first one; frames of
 * another format are left out. A frame smaller than the largest one is drawn at the top-left corner.
 */
export function encodeAnimatedPng(frames: readonly AnimationFrame[]): Buffer {
  const parsedFrames = frames.map((frame) => ({ ...parsePng(frame.png), delayMs: frame.delayMs }));
  const pixelFormat = parsedFrames[0]?.header.subarray(8);
  if (!pixelFormat) throw new Error('an animated PNG needs at least one frame');
  const animationFrames = parsedFrames
    .filter((frame) => frame.header.subarray(8).equals(pixelFormat))
    .map((frame) => ({ ...frame, width: frame.header.readUInt32BE(0), height: frame.header.readUInt32BE(4) }));
  const [firstFrame] = animationFrames as [(typeof animationFrames)[number], ...typeof animationFrames];
  const width = Math.max(...animationFrames.map((frame) => frame.width));
  const height = Math.max(...animationFrames.map((frame) => frame.height));

  const header = Buffer.from(firstFrame.header);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(animationFrames.length, 0);
  const chunks = [
    PNG_SIGNATURE,
    createChunk('IHDR', header),
    ...firstFrame.metadataChunks,
    createChunk('acTL', animationControl),
  ];

  // The image shown by viewers without animation support must fill the canvas. Only a first frame
  // of that size can serve as it; otherwise it is a blank image that is not part of the animation.
  const startsWithFirstFrame = firstFrame.width === width && firstFrame.height === height;
  if (!startsWithFirstFrame) {
    const bitsPerPixel = (pixelFormat[0] as number) * (CHANNELS_BY_COLOR_TYPE[pixelFormat[1] as number] ?? 1);
    const blankScanlines = Buffer.alloc(height * (1 + Math.ceil((width * bitsPerPixel) / 8)));
    chunks.push(createChunk('IDAT', zlib.deflateSync(blankScanlines)));
  }

  let sequenceNumber = 0;
  for (const [index, frame] of animationFrames.entries()) {
    const frameControl = Buffer.alloc(26);
    frameControl.writeUInt32BE(sequenceNumber++, 0);
    frameControl.writeUInt32BE(frame.width, 4);
    frameControl.writeUInt32BE(frame.height, 8);
    // The x and y offsets at 12 and 16 stay 0.
    // The delay is a fraction of two 16-bit integers: milliseconds, or seconds when those do not fit.
    const delayUnitsPerSecond = frame.delayMs <= MAX_UINT16 ? 1000 : 1;
    const delay = Math.round((frame.delayMs * delayUnitsPerSecond) / 1000);
    frameControl.writeUInt16BE(Math.min(Math.max(delay, 1), MAX_UINT16), 20);
    frameControl.writeUInt16BE(delayUnitsPerSecond, 22);
    // Every frame is cleared before the next one, so a larger frame does not stay visible around a smaller one.
    frameControl.writeUInt8(1, 24);
    chunks.push(createChunk('fcTL', frameControl));

    if (index === 0 && startsWithFirstFrame) {
      chunks.push(createChunk('IDAT', frame.imageData));
    } else {
      const sequence = Buffer.alloc(4);
      sequence.writeUInt32BE(sequenceNumber++);
      chunks.push(createChunk('fdAT', Buffer.concat([sequence, frame.imageData])));
    }
  }
  chunks.push(createChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function parsePng(png: Buffer): ParsedPng {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('not a PNG image');

  let header: Buffer | undefined;
  const metadataChunks: Buffer[] = [];
  const imageDataChunks: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= png.length) {
    const dataLength = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + dataLength);
    const nextOffset = offset + 12 + dataLength;
    if (type === 'IHDR') {
      header = data;
    } else if (type === 'IDAT') {
      imageDataChunks.push(data);
    } else if (imageDataChunks.length === 0 && type !== 'IEND') {
      metadataChunks.push(png.subarray(offset, nextOffset));
    }
    offset = nextOffset;
  }
  if (header?.length !== 13 || imageDataChunks.length === 0) throw new Error('not a PNG image');
  return { header, metadataChunks, imageData: Buffer.concat(imageDataChunks) };
}

function createChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const chunk = Buffer.alloc(typeAndData.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(zlib.crc32(typeAndData), chunk.length - 4);
  return chunk;
}
