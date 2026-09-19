import sharp from 'sharp';

// Synthetic abstract glyphs only: no article images, saved templates or network.
export async function outlineFixture({ transparentPatch = false } = {}) {
  const width = 480, height = 360, left = 70, top = 242, tw = 300, th = 100;
  const original = Buffer.alloc(width * height * 4);
  for (let p = 0; p < original.length; p += 4) {
    original[p] = original[p + 1] = original[p + 2] = 170;
    original[p + 3] = 255;
  }
  const yellow = new Uint8Array(tw * th), dark = new Uint8Array(tw * th);
  for (let row = 0; row < 2; row++) for (let glyph = 0; glyph < 10; glyph++) {
    for (let y = 0; y < 18; y++) for (let x = 0; x < 15; x++) {
      if (!(x < 3 || y < 3 || (glyph % 3 === 0 && y > 14) || (glyph % 3 === 1 && x > 11) || (glyph % 3 === 2 && y > 8 && y < 12))) continue;
      const gx = 18 + glyph * 27 + x;
      const gy = 33 + row * 41 + y - Math.floor(gx / 18);
      yellow[gy * tw + gx] = 1;
    }
  }
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    if (!yellow[y * tw + x]) continue;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (x + dx >= 0 && x + dx < tw && y + dy >= 0 && y + dy < th) dark[(y + dy) * tw + x + dx] = 1;
    }
  }
  // This black patch is in the calibration selection but far from any glyph.
  const farPatch = { x: 3, y: 3, width: 7, height: 7 };
  for (let y = 3; y < 10; y++) for (let x = 3; x < 10; x++) {
    const p = ((top + y) * width + left + x) * 4;
    original[p] = original[p + 1] = original[p + 2] = 20;
    if (transparentPatch) original[p + 3] = 0;
  }
  const raw = Buffer.from(original);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = y * tw + x, p = ((top + y) * width + left + x) * 4;
    if (!dark[i]) continue;
    if (yellow[i]) { raw[p] = 255; raw[p + 1] = 180; raw[p + 2] = 0; }
    else { raw[p] = raw[p + 1] = raw[p + 2] = 24; }
  }
  return {
    input: await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    width, height, left, top, tw, th, original, raw, yellow, dark, farPatch,
    region: [left / width, top / height, tw / width, th / height],
  };
}
