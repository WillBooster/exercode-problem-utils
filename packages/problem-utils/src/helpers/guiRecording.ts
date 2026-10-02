import crypto from 'node:crypto';
import zlib from 'node:zlib';

/** Bounds the recordings of one GUI run in total, so a judge server can budget for them. */
export const MAX_GUI_RECORDING_BYTES = 2 * 1024 * 1024;

export interface GuiRecordingFile {
  path: string;
  data: string;
  encoding: 'base64';
}

interface CapturedFrame {
  png: Buffer;
  capturedAtMs: number;
}

interface WindowCaptures {
  path: string;
  /** The captures kept for the recording; none once the window turned out too large to record. */
  frames: CapturedFrame[];
  /** A digest of the last capture, kept or not, to tell whether the window changed. */
  lastDigest: string;
  changeCount: number;
  /** Every how many changes a capture is kept; doubled whenever half of the kept frames are dropped. */
  keptChangeInterval: number;
  lastSeenAtMs: number;
  isTooLarge: boolean;
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
const MIN_RECORDED_CHANGE_COUNT = 3;

/**
 * Collects the screenshots of each window over a run and turns the windows that kept changing into
 * animated PNGs, which browsers play wherever they show a PNG. The captures it keeps are bounded
 * like the recordings, however long the run lasts and whatever the windows show.
 */
export class GuiRecorder {
  readonly #windowIdToCaptures = new Map<string, WindowCaptures>();

  add(windowId: string, screenshot: { path: string; data: string }, capturedAtMs: number): void {
    const captures = this.#windowIdToCaptures.get(windowId) ?? {
      path: '',
      frames: [],
      lastDigest: '',
      changeCount: 0,
      keptChangeInterval: 1,
      lastSeenAtMs: 0,
      isTooLarge: false,
    };
    this.#windowIdToCaptures.set(windowId, captures);
    captures.path = screenshot.path.replace(/\.png$/, '_recording.png');
    captures.lastSeenAtMs = capturedAtMs;
    // An unchanged window only extends how long its last frame is shown.
    const digest = crypto.createHash('sha256').update(screenshot.data).digest('base64');
    if (captures.lastDigest === digest) return;

    captures.lastDigest = digest;
    const changeIndex = captures.changeCount++;
    if (captures.isTooLarge || changeIndex % captures.keptChangeInterval !== 0) return;

    captures.frames.push({ png: Buffer.from(screenshot.data, 'base64'), capturedAtMs });
    this.#shrinkToFit(({ frames }) => frames.reduce((sum, frame) => sum + frame.png.length, 0));
  }

  /** @param frameIntervalMs How long the last capture of a window is shown. */
  build(frameIntervalMs: number): GuiRecordingFile[] {
    const framesToAnimatedPng = new Map<CapturedFrame[], Buffer>();
    const encode = ({ frames, lastSeenAtMs }: WindowCaptures): Buffer => {
      const animatedPng =
        framesToAnimatedPng.get(frames) ??
        encodeAnimatedPng(
          frames.map((frame, index) => ({
            png: frame.png,
            delayMs: (frames[index + 1]?.capturedAtMs ?? lastSeenAtMs + frameIntervalMs) - frame.capturedAtMs,
          }))
        );
      framesToAnimatedPng.set(frames, animatedPng);
      return animatedPng;
    };
    const isRecorded = (captures: WindowCaptures): boolean => isAnimated(captures) && captures.frames.length > 1;

    // The chunks an animated PNG adds per frame can exceed what the frames alone were bounded to.
    this.#shrinkToFit((captures) => (isRecorded(captures) ? encode(captures).length : 0));
    return [...this.#windowIdToCaptures.values()].filter(isRecorded).map((captures) => ({
      path: captures.path,
      data: encode(captures).toString('base64'),
      encoding: 'base64',
    }));
  }

  /**
   * Frees space until all windows together fit `MAX_GUI_RECORDING_BYTES`, giving up what matters
   * least first: the early captures of a window that is not animated (yet), then every other frame
   * of the largest animated window, and only when no window has more than two frames a whole window,
   * which is then not recorded.
   */
  #shrinkToFit(measure: (captures: WindowCaptures) => number): void {
    const allCaptures = [...this.#windowIdToCaptures.values()];
    for (;;) {
      const sizes = new Map(allCaptures.map((captures) => [captures, measure(captures)]));
      if ([...sizes.values()].reduce((sum, size) => sum + size, 0) <= MAX_GUI_RECORDING_BYTES) return;

      const bySizeDescending = allCaptures
        .filter((captures) => captures.frames.length > 0)
        .toSorted((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0));
      // The fewer changes a window showed, the less likely it is the start of an animation.
      const [notAnimated] = bySizeDescending
        .filter((captures) => !isAnimated(captures))
        .toSorted((a, b) => a.changeCount - b.changeCount);
      const shrinkable = bySizeDescending.find((captures) => captures.frames.length > 2);
      if (notAnimated) {
        notAnimated.frames = [];
      } else if (shrinkable) {
        shrinkable.frames = shrinkable.frames.filter((_, index) => index % 2 === 0);
        shrinkable.keptChangeInterval *= 2;
      } else {
        const [largest] = bySizeDescending as [WindowCaptures, ...WindowCaptures[]];
        largest.frames = [];
        largest.isTooLarge = true;
      }
    }
  }
}

function isAnimated(captures: WindowCaptures): boolean {
  return captures.changeCount >= MIN_RECORDED_CHANGE_COUNT;
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
    // The delay is a fraction of two 16-bit integers: milliseconds, or the finest unit a longer delay fits in.
    const delayUnitsPerSecond = Math.max(1, Math.min(1000, Math.floor((MAX_UINT16 * 1000) / frame.delayMs)));
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
