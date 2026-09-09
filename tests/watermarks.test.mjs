import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createColorTemplate, createYellowTemplate, removeAndBrandWatermark, removeKnownWatermark, validateSettings, validateWatermarkTemplate } from '../scripts/watermark-engine.mjs';

export async function fixture(opacity = 1, color = [255, 180, 0]) {
  const width = 320, height = 240, tw = 80, th = 32, left = 225, top = 190;
  const template = Buffer.alloc(tw * th * 4), original = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4, value = 135 + Math.floor(x / 20) + Math.floor(y / 20);
    original[p] = value; original[p + 1] = value; original[p + 2] = value; original[p + 3] = 255;
  }
  for (let y = 3; y < th - 3; y++) for (let x = 3; x < tw - 3; x++) {
    if ((x % 13 < 3 && y < 24) || (y % 11 < 3 && x % 17 < 11) || (x > 58 && y > 20 && x % 4 < 2)) {
      const p = (y * tw + x) * 4;
      template[p] = color[0]; template[p + 1] = color[1]; template[p + 2] = color[2]; template[p + 3] = 255;
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

test('default and explicit yellow extraction preserve the legacy glyph mask', async () => {
  const f = await fixture();
  const region = [f.left / f.width, f.top / f.height, f.tw / f.width, f.th / f.height];
  const legacy = await createYellowTemplate(f.input, region);
  assert.deepEqual(await createColorTemplate(f.input, region), legacy);
  assert.deepEqual(await createColorTemplate(f.input, region, 'yellow'), legacy);
  assert.deepEqual(await sharp(Buffer.from(legacy.template, 'base64')).raw().toBuffer(), await sharp(f.template).raw().toBuffer());
});

for (const [name, color, jpeg] of [['black', [0, 0, 0], false], ['dark gray JPEG', [55, 55, 55], true]]) {
  test(`${name} extraction creates a transparent mask usable by the repair and branding pipeline`, async () => {
    const f = await fixture(1, color);
    const input = jpeg ? await sharp(f.input).jpeg({ quality: 95 }).toBuffer() : f.input;
    const original = Buffer.from(input);
    const settings = await createColorTemplate(input, [f.left / f.width, f.top / f.height, f.tw / f.width, f.th / f.height], 'black');
    assert.equal(settings.extractionColor, 'black');
    assert.equal(settings.mode, 'inpaint');
    const template = Buffer.from(settings.template, 'base64');
    await validateWatermarkTemplate(template);
    const pixels = await sharp(template).ensureAlpha().raw().toBuffer();
    assert.ok(pixels.some((v, i) => i % 4 === 3 && v === 0));
    assert.ok(pixels.some((v, i) => i % 4 === 3 && v === 255));
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3]) assert.ok(Math.max(pixels[p], pixels[p + 1], pixels[p + 2]) <= 95);
    const result = await removeAndBrandWatermark(input, template, settings);
    assert.equal(result.status, 'processed', JSON.stringify(result));
    assert.ok(Math.abs(result.region.x - f.left) <= 1);
    assert.ok(Math.abs(result.region.y - f.top) <= 1);
    assert.equal(result.platformWatermark.text, '深巷');
    assert.deepEqual(input, original);
    await assert.rejects(createColorTemplate(input, [f.left / f.width, f.top / f.height, f.tw / f.width, f.th / f.height], 'yellow'), /黄色/);
  });
}

test('black extraction rejects empty, fully dark, transparent and colored regions; invalid input fails closed', async () => {
  const f = await fixture();
  const region = [f.left / f.width, f.top / f.height, f.tw / f.width, f.th / f.height];
  await assert.rejects(createColorTemplate(f.input, region, 'black'), /黑色/);
  for (const background of [{ r: 0, g: 0, b: 0, alpha: 1 }, { r: 0, g: 0, b: 0, alpha: 0 }]) {
    const input = await sharp({ create: { width: 80, height: 32, channels: 4, background } }).png().toBuffer();
    await assert.rejects(createColorTemplate(input, [0, 0, 1, 1], 'black'), /黑色/);
  }
  const colored = await fixture(1, [0, 15, 90]);
  await assert.rejects(createColorTemplate(colored.input, region, 'black'), /黑色/);
  for (const color of ['red', null, 0, {}]) await assert.rejects(createColorTemplate(f.input, region, color), /颜色/);
  for (const bad of [[NaN, 0, 0.2, 0.2], ['0', 0, 0.2, 0.2], [0.9, 0.9, 0.2, 0.2], [0, 0, 0, 1]]) {
    await assert.rejects(createColorTemplate(f.input, bad, 'black'), /区域/);
  }
  assert.throws(() => validateSettings({ ...f.settings, extractionColor: 'red' }), /颜色/);
});

test('combined pipeline adds one deterministic translucent 深巷 mark after repair without modifying original', async () => {
  const f = await fixture();
  const original = Buffer.from(f.input);
  const repaired = await removeKnownWatermark(f.input, f.template, f.settings);
  const result = await removeAndBrandWatermark(f.input, f.template, f.settings);
  assert.equal(result.status, 'processed');
  assert.equal(result.platformWatermark.text, '深巷');
  assert.equal(result.platformWatermark.opacity, 179);
  assert.equal(result.platformWatermark.transparencyPercent, 30);
  assert.equal(result.platformWatermark.position, 'bottom-right');
  const { x, y, width, height } = result.platformWatermark.region;
  assert.ok(x > 0 && y > 0 && x + width < f.width && y + height < f.height);
  const { data: output, info } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const before = await sharp(repaired.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(info.width, f.width); assert.equal(info.height, f.height);
  let changed = 0, white = 0, orange = 0;
  for (let j = 0; j < f.height; j++) for (let i = 0; i < f.width; i++) {
    const p = (j * f.width + i) * 4;
    if (i < x || i >= x + width || j < y || j >= y + height) {
      assert.deepEqual(output.subarray(p, p + 4), before.subarray(p, p + 4));
    } else {
      if (!output.subarray(p, p + 3).equals(before.subarray(p, p + 3))) changed++;
      if (output[p] > 180 && Math.abs(output[p] - output[p + 1]) < 3 && Math.abs(output[p] - output[p + 2]) < 3) white++;
      if (output[p] > output[p + 1] + 20 && output[p + 1] > output[p + 2] + 20) orange++;
    }
    assert.equal(output[p + 3], 255);
  }
  assert.ok(changed > 30 && white > 10 && orange > 0, `Changed ${changed}, white ${white}, orange ${orange}`);
  assert.deepEqual(f.input, original);
  assert.deepEqual((await removeAndBrandWatermark(f.input, f.template, f.settings)).bytes, result.bytes);
});

test('combined pipeline never brands a skipped image', async () => {
  const f = await fixture();
  const input = await sharp(f.original, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toBuffer();
  const result = await removeAndBrandWatermark(input, f.template, f.settings);
  assert.equal(result.status, 'skipped');
  assert.equal(result.bytes, undefined);
  assert.equal(result.platformWatermark, undefined);
});
