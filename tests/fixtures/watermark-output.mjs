import sharp from 'sharp';

export const OUTPUT_FIXTURE_WIDTH = 2048;
export const OUTPUT_FIXTURE_HEIGHT = 1536;

// Deterministic, synthetic pixels only; no network, user media or persistence.
export function outputNoise(transparent = false) {
  const data = Buffer.alloc(OUTPUT_FIXTURE_WIDTH * OUTPUT_FIXTURE_HEIGHT * 4);
  let seed = 0x28f94ea3;
  for (let p = 0; p < data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      data[p + c] = seed & 255;
    }
    data[p + 3] = transparent ? ((p / 4) % 256) : 255;
  }
  return data;
}

// JPEG source is below 8 MiB; its lossless repair output exceeds 8 MiB.
// Keep glyphs surrounded by neutral pixels so location remains deterministic.
export async function largeJpegFixture() {
  const width = OUTPUT_FIXTURE_WIDTH, height = OUTPUT_FIXTURE_HEIGHT;
  const info = { width, height, channels: 4 };
  const data = outputNoise(), tw = 80, th = 32, markWidth = 512, markHeight = 205;
  const left = 1490, top = 1290;
  const glyphs = Buffer.alloc(tw * th * 4);
  for (let y = 3; y < th - 3; y++) for (let x = 3; x < tw - 3; x++) {
    if ((x % 13 < 3 && y < 24) || (y % 11 < 3 && x % 17 < 11) || (x > 58 && y > 20 && x % 4 < 2)) {
      const p = (y * tw + x) * 4;
      glyphs[p] = 255; glyphs[p + 1] = 180; glyphs[p + 3] = 255;
    }
  }
  const template = await sharp(glyphs, { raw: { width: tw, height: th, channels: 4 } }).png().toBuffer();
  const enlarged = await sharp(template).resize(markWidth, markHeight, { kernel: 'nearest' }).raw().toBuffer();
  for (let y = 0; y < markHeight; y++) for (let x = 0; x < markWidth; x++) {
    const p = ((top + y) * width + left + x) * 4, t = (y * markWidth + x) * 4;
    for (let c = 0; c < 3; c++) data[p + c] = enlarged[t + 3] ? enlarged[t + c] : 145;
  }
  const input = await sharp(data, { raw: info }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  const settings = { relativeWidth: markWidth / width, mode: 'inpaint', search: 'bottom-right', opacity: 1, threshold: 0.86, padding: 1 };
  return { input, template, settings, width, height };
}
