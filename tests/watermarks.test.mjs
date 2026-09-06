import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createYellowTemplate, removeKnownWatermark, validateSettings } from '../scripts/watermark-engine.mjs';

export async function fixture(opacity = 1) {
  const width = 320, height = 240, tw = 80, th = 32, left = 225, top = 190;
  const template = Buffer.alloc(tw * th * 4), original = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4, value = 135 + Math.floor(x / 20) + Math.floor(y / 20);
    original[p] = value; original[p + 1] = value; original[p + 2] = value; original[p + 3] = 255;
  }
  for (let y = 3; y < th - 3; y++) for (let x = 3; x < tw - 3; x++) {
    if ((x % 13 < 3 && y < 24) || (y % 11 < 3 && x % 17 < 11) || (x > 58 && y > 20 && x % 4 < 2)) {
      const p = (y * tw + x) * 4;
      template[p] = 255; template[p + 1] = 180; template[p + 2] = 0; template[p + 3] = 255;
    }
  }
  const input = Buffer.from(original);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const t = (y * tw + x) * 4, p = ((top + y) * width + left + x) * 4;
    if (!template[t + 3]) continue;
    for (let c = 0; c < 3; c++) input[p + c] = Math.round(original[p + c] * (1 - opacity) + template[t + c] * opacity);
  }
  return {
    input: await sharp(input, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    template: await sharp(template, { raw: { width: tw, height: th, channels: 4 } }).png().toBuffer(),
    original, width, height, left, top, tw, th,
    settings: { relativeWidth: tw / width, mode: opacity === 1 ? 'inpaint' : 'inverse', search: 'bottom-right', opacity, threshold: 0.86, padding: opacity === 1 ? 1 : 0 },
  };
}

test('opaque glyph mask repair improves a synthetic fixture and preserves pixels outside ROI', async () => {
  const f = await fixture();
  const sourceBefore = Buffer.from(f.input);
  const result = await removeKnownWatermark(f.input, f.template, f.settings);
  assert.equal(result.status, 'processed');
  assert.ok(result.confidence > 0.9);
  assert.ok(Math.abs(result.region.x - f.left) <= 1);
  const output = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  const before = await sharp(f.input).ensureAlpha().raw().toBuffer();
  let oldError = 0, newError = 0;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) for (let c = 0; c < 3; c++) {
    const p = (y * f.width + x) * 4 + c;
    if (x < f.left - 2 || x > f.left + f.tw + 2 || y < f.top - 2 || y > f.top + f.th + 2) assert.equal(output[p], before[p]);
    oldError += Math.abs(before[p] - f.original[p]); newError += Math.abs(output[p] - f.original[p]);
  }
  assert.ok(newError < oldError * 0.08, `${newError} vs ${oldError}`);
  assert.deepEqual(f.input, sourceBefore);
});

test('known alpha inverse blending preserves background detail', async () => {
  const f = await fixture(0.6);
  const result = await removeKnownWatermark(f.input, f.template, f.settings);
  assert.equal(result.status, 'processed');
  const output = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  let error = 0;
  for (let p = 0; p < output.length; p++) error += Math.abs(output[p] - f.original[p]);
  assert.ok(error / output.length < 0.2);
  assert.equal(result.repairedPixels, 0);
});

test('no watermark fails closed without output bytes', async () => {
  const f = await fixture();
  const plain = await sharp(f.original, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toBuffer();
  const result = await removeKnownWatermark(plain, f.template, f.settings);
  assert.equal(result.status, 'skipped'); assert.equal(result.bytes, undefined);
});

test('calibration extracts only yellow glyphs and rejects empty/invalid regions', async () => {
  const f = await fixture();
  const settings = await createYellowTemplate(f.input, [f.left / f.width, f.top / f.height, f.tw / f.width, f.th / f.height]);
  assert.equal(settings.mode, 'inpaint');
  const result = await removeKnownWatermark(f.input, Buffer.from(settings.template, 'base64'), settings);
  assert.equal(result.status, 'processed');
  await assert.rejects(createYellowTemplate(f.input, [0, 0, 0.2, 0.2]), /黄色/);
  await assert.rejects(createYellowTemplate(f.input, [0.9, 0.9, 0.2, 0.2]), /区域/);
});

test('invalid settings and non-raster templates are rejected', async () => {
  const f = await fixture();
  assert.throws(() => validateSettings({ ...f.settings, opacity: 0 }), /参数/);
  assert.throws(() => validateSettings({ ...f.settings, threshold: NaN }), /参数/);
  await assert.rejects(removeKnownWatermark(f.input, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="32"/>'), f.settings), /SVG/);
  await assert.rejects(removeKnownWatermark(f.input, Buffer.from('garbage'), f.settings));
});
