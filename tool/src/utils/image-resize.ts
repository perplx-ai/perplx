import type { ImageContent } from '@mariozechner/pi-ai';
import { applyExifOrientation } from './exif-orientation.js';
import { loadPhoton } from './photon.js';

export interface ImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ResizedImage {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: DEFAULT_MAX_BYTES,
  jpegQuality: 80
};

function pickSmaller(
  a: { buffer: Uint8Array; mimeType: string },
  b: { buffer: Uint8Array; mimeType: string }
): { buffer: Uint8Array; mimeType: string } {
  return a.buffer.length <= b.buffer.length ? a : b;
}

export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const inputBuffer = Buffer.from(img.data, 'base64');

  const photon = await loadPhoton();
  if (!photon) {
    return {
      data: img.data,
      mimeType: img.mimeType,
      originalWidth: 0,
      originalHeight: 0,
      width: 0,
      height: 0,
      wasResized: false
    };
  }

  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
  try {
    const inputBytes = new Uint8Array(inputBuffer);
    const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
    image = applyExifOrientation(photon, rawImage, inputBytes);
    if (image !== rawImage) rawImage.free();

    const originalWidth = image.get_width();
    const originalHeight = image.get_height();
    const format = img.mimeType?.split('/')[1] ?? 'png';

    const originalSize = inputBuffer.length;
    if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && originalSize <= opts.maxBytes) {
      return {
        data: img.data,
        mimeType: img.mimeType ?? `image/${format}`,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false
      };
    }

    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    if (targetWidth > opts.maxWidth) {
      targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
      targetWidth = opts.maxWidth;
    }
    if (targetHeight > opts.maxHeight) {
      targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
      targetHeight = opts.maxHeight;
    }

    function tryBothFormats(width: number, height: number, jpegQuality: number): { buffer: Uint8Array; mimeType: string } {
      const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

      try {
        const pngBuffer = resized.get_bytes();
        const jpegBuffer = resized.get_bytes_jpeg(jpegQuality);

        return pickSmaller({ buffer: pngBuffer, mimeType: 'image/png' }, { buffer: jpegBuffer, mimeType: 'image/jpeg' });
      } finally {
        resized.free();
      }
    }

    const qualitySteps = [85, 70, 55, 40];
    const scaleSteps = [1.0, 0.75, 0.5, 0.35, 0.25];

    let best: { buffer: Uint8Array; mimeType: string };
    let finalWidth = targetWidth;
    let finalHeight = targetHeight;

    best = tryBothFormats(targetWidth, targetHeight, opts.jpegQuality);

    if (best.buffer.length <= opts.maxBytes) {
      return {
        data: Buffer.from(best.buffer).toString('base64'),
        mimeType: best.mimeType,
        originalWidth,
        originalHeight,
        width: finalWidth,
        height: finalHeight,
        wasResized: true
      };
    }

    for (const quality of qualitySteps) {
      best = tryBothFormats(targetWidth, targetHeight, quality);

      if (best.buffer.length <= opts.maxBytes) {
        return {
          data: Buffer.from(best.buffer).toString('base64'),
          mimeType: best.mimeType,
          originalWidth,
          originalHeight,
          width: finalWidth,
          height: finalHeight,
          wasResized: true
        };
      }
    }

    for (const scale of scaleSteps) {
      finalWidth = Math.round(targetWidth * scale);
      finalHeight = Math.round(targetHeight * scale);

      if (finalWidth < 100 || finalHeight < 100) {
        break;
      }

      for (const quality of qualitySteps) {
        best = tryBothFormats(finalWidth, finalHeight, quality);

        if (best.buffer.length <= opts.maxBytes) {
          return {
            data: Buffer.from(best.buffer).toString('base64'),
            mimeType: best.mimeType,
            originalWidth,
            originalHeight,
            width: finalWidth,
            height: finalHeight,
            wasResized: true
          };
        }
      }
    }

    return {
      data: Buffer.from(best.buffer).toString('base64'),
      mimeType: best.mimeType,
      originalWidth,
      originalHeight,
      width: finalWidth,
      height: finalHeight,
      wasResized: true
    };
  } catch {
    return {
      data: img.data,
      mimeType: img.mimeType,
      originalWidth: 0,
      originalHeight: 0,
      width: 0,
      height: 0,
      wasResized: false
    };
  } finally {
    if (image) {
      image.free();
    }
  }
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) {
    return undefined;
  }

  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
