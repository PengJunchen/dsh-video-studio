// This is a fast, display-sized estimate. The media worker remains the source
// of the final, full-resolution preview and rendered video.
export const SHADOW_START = 0;
export const SHADOW_END = .40;
export const HIGHLIGHT_START = .55;
export const HIGHLIGHT_END = 1.0;
export const SHADOW_RANGE = Object.freeze([SHADOW_START, SHADOW_END]);
export const HIGHLIGHT_RANGE = Object.freeze([HIGHLIGHT_START, HIGHLIGHT_END]);
export const TONE_ALGORITHM_VERSION = 'shared-tone-v3';
export const LOW_LIGHT_ALGORITHM_VERSION = 'low-light-v1';

export function smoothstep(start, end, value) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

export function lowLightMap(luminance, amount) {
  if (!amount || luminance <= 0 || luminance >= SHADOW_END) return luminance;
  const t = luminance / SHADOW_END;
  const slope = 2 ** (3 * amount);
  return luminance * (t + slope * (1 - t)) / (1 + (slope - 1) * t * (1 - t));
}

export function toneGain(luminance, shadows, highlights, lowLight = 0) {
  let gain;
  if (luminance < SHADOW_END) {
    const t = Math.max(0, luminance) / SHADOW_END;
    const slope = 2 ** (4 * shadows);
    gain = (t + slope * (1 - t)) / (1 + (slope - 1) * t * (1 - t));
  } else if (luminance <= HIGHLIGHT_START) {
    gain = 1;
  } else {
    const distance = luminance - HIGHLIGHT_START;
    const span = HIGHLIGHT_END - HIGHLIGHT_START;
    const endpointGain = 2 ** (2 * highlights);
    const mapped = HIGHLIGHT_START + (highlights < 0
      ? distance / (1 + (1 / endpointGain - 1) * distance / span)
      : distance * (1 + (endpointGain - 1) * distance / span));
    gain = mapped / luminance;
  }
  if (!lowLight) return gain;
  if (luminance <= 0) return gain * 2 ** (3 * lowLight);
  return lowLightMap(luminance * gain, lowLight) / luminance;
}

export function toneLookup(shadows, highlights, lowLight = 0) {
  const gains = new Float32Array(16384);
  for (let index = 0; index < gains.length; index++) {
    gains[index] = toneGain(index / 16383, shadows ?? 0, highlights ?? 0, lowLight ?? 0);
  }
  return gains;
}

export function relativeToneLookup(previousShadows, previousHighlights, shadows, highlights,
  previousLowLight = 0, lowLight = 0) {
  const previous = toneLookup(previousShadows, previousHighlights, previousLowLight);
  const current = toneLookup(shadows, highlights, lowLight);
  for (let index = 0; index < current.length; index++) current[index] /= previous[index];
  return current;
}

export function luminanceIndices(pixels) {
  const values = new Uint16Array(pixels.length / 4);
  for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index++) {
    values[index] = Math.round((.2126 * pixels[pixel] + .7152 * pixels[pixel + 1]
      + .0722 * pixels[pixel + 2]) / 255 * 16383);
  }
  return values;
}

export function applyTonePixels(source, destination, indices, gains, unboostedGains = null) {
  if (source.length !== destination.length || source.length !== indices.length * 4) {
    throw new Error('实时预览画面尺寸不匹配。');
  }
  for (let pixel = 0, index = 0; pixel < source.length; pixel += 4, index++) {
    let gain = gains[indices[index]];
    if (unboostedGains) {
      const largest = Math.max(source[pixel], source[pixel + 1], source[pixel + 2]);
      if (largest > 0) gain = Math.min(gain, Math.max(unboostedGains[indices[index]], 255 / largest));
    }
    destination[pixel] = source[pixel] * gain;
    destination[pixel + 1] = source[pixel + 1] * gain;
    destination[pixel + 2] = source[pixel + 2] * gain;
    destination[pixel + 3] = source[pixel + 3];
  }
}

export class LiveToneRenderer {
  constructor(baseImage, calibratedImage, widthLimit = 640, highPrecision = null) {
    const scale = Math.min(1, widthLimit / baseImage.naturalWidth);
    this.width = Math.max(1, Math.round(baseImage.naturalWidth * scale));
    this.height = Math.max(1, Math.round(baseImage.naturalHeight * scale));
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = this.width;
    sourceCanvas.height = this.height;
    const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(baseImage, 0, 0, this.width, this.height);
    this.base = context.getImageData(0, 0, this.width, this.height).data;
    if (highPrecision) {
      const { buffer, width, height } = highPrecision;
      if (width !== this.width || height !== this.height || buffer.byteLength !== width*height*6) {
        throw new Error('高精度预览数据尺寸不匹配。');
      }
      const view = new DataView(buffer);
      this.base = new Float32Array(width*height*4);
      for (let index = 0; index < width*height; index++) {
        for (let channel = 0; channel < 3; channel++) {
          this.base[index*4+channel] = view.getUint16((index*3+channel)*2, true)/65535*255;
        }
        this.base[index*4+3] = 255;
      }
    }
    this.indices = luminanceIndices(this.base);
    context.clearRect(0, 0, this.width, this.height);
    context.drawImage(calibratedImage, 0, 0, this.width, this.height);
    this.calibrated = context.getImageData(0, 0, this.width, this.height).data;
    this.output = context.createImageData(this.width, this.height);
  }

  draw(canvas, previousShadows, previousHighlights, shadows, highlights, relative = false,
    previousLowLight = 0, lowLight = 0) {
    if (canvas.width !== this.width) canvas.width = this.width;
    if (canvas.height !== this.height) canvas.height = this.height;
    const context = canvas.getContext('2d');
    const gains = relative
      ? relativeToneLookup(previousShadows, previousHighlights, shadows, highlights,
        previousLowLight, lowLight)
      : toneLookup(shadows, highlights, lowLight);
    const unboosted = lowLight ? (relative
      ? relativeToneLookup(previousShadows, previousHighlights, shadows, highlights,
        previousLowLight, 0)
      : toneLookup(shadows, highlights)) : null;
    applyTonePixels(relative ? this.calibrated : this.base, this.output.data,
      this.indices, gains, unboosted);
    context.putImageData(this.output, 0, 0);
  }
}
