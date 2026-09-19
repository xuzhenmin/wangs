import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  MAX_WATERMARK_INPUT_PIXELS,
  createColorTemplate,
  removeKnownWatermark,
  validateWatermarkTemplate,
} from '../scripts/watermark-engine.mjs';

// All fixtures are synthetic and stay in memory. No article/media files or
// saved administrator templates are read or changed by these regressions.
async function glyphs(color, width = 80, height = 32) {
  const raw = Buffer.alloc(80 * 32 * 4);
  for (let y = 3; y < 29; y++) for (let x = 3; x < 77; x++) {
    if ((x % 13 < 3 && y < 24) || (y % 11 < 3 && x % 17 < 11) || (x > 58 && y > 20 && x % 4 < 2)) {
      const p = (y * 80 + x) * 4;
      raw[p] = color[0]; raw[p + 1] = color[1]; raw[p + 2] = color[2]; raw[p + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 80, height: 32, channels: 4 } })
    .resize(width, height, { kernel: 'nearest' }).png().toBuffer();
}

async function sample({ width, height, left, top, markWidth, markHeight, color = [255, 180, 0], format = 'png', orientation }) {
  const mark = await glyphs(color, markWidth, markHeight);
  const image = sharp({ create: { width, height, channels: 4, background: '#969696' } })
    .composite([{ input: mark, left, top }]);
  if (orientation) image.withMetadata({ orientation });
  return { input: await image[format]({ quality: 95 }).toBuffer(), mark };
}

function opaquePixels(data) {
  let count = 0;
  for (let p = 3; p < data.length; p += 4) if (data[p]) count++;
  return count;
}

for (const [color, rgb, format] of [['yellow', [255, 180, 0], 'png'], ['black', [25, 25, 25], 'jpeg']]) {
  test(`32 MP ${format} sample supports ${color} template extraction without changing the input`, async () => {
    const width = 4000, height = 8000, left = 3000, top = 7300, markWidth = 800, markHeight = 320;
    assert.ok(width * height >= 31_000_000 && width * height <= MAX_WATERMARK_INPUT_PIXELS);
    const { input } = await sample({ width, height, left, top, markWidth, markHeight, color: rgb, format });
    const original = Buffer.from(input);
    const settings = await createColorTemplate(input, [left / width, top / height, markWidth / width, markHeight / height], color);
    const template = Buffer.from(settings.template, 'base64');
    await validateWatermarkTemplate(template);
    const { data, info } = await sharp(template).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, markWidth); assert.equal(info.height, markHeight);
    assert.equal(settings.relativeWidth, markWidth / width);
    assert.equal(settings.extractionColor, color);
    assert.ok(opaquePixels(data) > 80);
    assert.deepEqual(input, original);
  });
}

test('a selected region above 1 MP is reduced only for the template and retains its original relative width', async () => {
  const width = 4000, height = 4000, left = 1800, top = 3000, markWidth = 2000, markHeight = 800;
  const { input } = await sample({ width, height, left, top, markWidth, markHeight });
  const settings = await createColorTemplate(input, [left / width, top / height, markWidth / width, markHeight / height]);
  const template = Buffer.from(settings.template, 'base64');
  const meta = await sharp(template).metadata();
  assert.ok(meta.width * meta.height <= 1_000_000);
  assert.ok(meta.width < markWidth && meta.height < markHeight);
  assert.ok(Math.abs(meta.width / meta.height - markWidth / markHeight) < 0.005);
  assert.equal(settings.relativeWidth, markWidth / width);
  assert.notEqual(settings.relativeWidth, meta.width / width);
  await validateWatermarkTemplate(template);
  const original = await sharp(input).metadata();
  assert.equal(original.width, width); assert.equal(original.height, height);
});

for (const orientation of [6, 8]) {
  test(`EXIF orientation ${orientation} applies the selection to displayed rather than encoded coordinates`, async () => {
    const width = 320, height = 240, left = 225, top = 190, markWidth = 80, markHeight = 32;
    const { input } = await sample({ width, height, left, top, markWidth, markHeight, format: 'jpeg', orientation });
    assert.equal((await sharp(input).metadata()).orientation, orientation);
    const displayedWidth = height, displayedHeight = width;
    const crop = orientation === 6
      ? { left: height - top - markHeight, top: left, width: markHeight, height: markWidth }
      : { left: top, top: width - left - markWidth, width: markHeight, height: markWidth };
    const settings = await createColorTemplate(input, [crop.left / displayedWidth, crop.top / displayedHeight, crop.width / displayedWidth, crop.height / displayedHeight]);
    assert.equal(settings.relativeWidth, crop.width / displayedWidth);
    const { data, info } = await sharp(Buffer.from(settings.template, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, crop.width); assert.equal(info.height, crop.height);
    const expected = await sharp(input).rotate().extract(crop).ensureAlpha().raw().toBuffer();
    const mask = Buffer.alloc(expected.length);
    for (let p = 0; p < expected.length; p += 4) {
      const [r, g, b] = expected.subarray(p, p + 3);
      if (r > 160 && g > 90 && g < r * 0.94 && b < g * 0.65 && r - b > 85) {
        mask[p] = r; mask[p + 1] = g; mask[p + 2] = b; mask[p + 3] = 255;
      }
    }
    assert.ok(opaquePixels(mask) > 80);
    assert.deepEqual(data, mask);
    await validateWatermarkTemplate(Buffer.from(settings.template, 'base64'));
  });
}

test('images above 40 MP fail with an actionable Chinese error before full decode', async () => {
  const input = await sharp({ create: { width: 8000, height: 5001, channels: 3, background: '#969696' } }).png().toBuffer();
  assert.ok(input.length < 8 * 1024 * 1024);
  await assert.rejects(createColorTemplate(input, [0.7, 0.8, 0.2, 0.1]), /超过 4000 万像素.*缩小/);
});

test('an uploaded template above 1 MP still fails instead of relaxing the template input guard', async () => {
  const template = await sharp({ create: { width: 1001, height: 1000, channels: 4, background: { r: 255, g: 180, b: 0, alpha: 0.25 } } }).png().toBuffer();
  assert.ok(template.length < 1024 * 1024);
  await assert.rejects(validateWatermarkTemplate(template), /模板超过 100 万像素/);
});

test('the processing path accepts a 14 MP image and safely skips when the watermark is absent', async () => {
  const width = 3500, height = 4000;
  const input = await sharp({ create: { width, height, channels: 3, background: '#969696' } }).png().toBuffer();
  const template = await glyphs([255, 180, 0]);
  const result = await removeKnownWatermark(input, template, {
    relativeWidth: 0.25, mode: 'inpaint', search: 'bottom-right', opacity: 0.7, threshold: 0.86, padding: 1,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.bytes, undefined);
  const meta = await sharp(input).metadata();
  assert.equal(meta.width, width); assert.equal(meta.height, height);
});

test('successful repair above the old 12 MP limit keeps the original display dimensions', async () => {
  const width = 3500, height = 4000, left = 2550, top = 3500, markWidth = 700, markHeight = 280;
  const { input } = await sample({ width, height, left, top, markWidth, markHeight });
  const original = Buffer.from(input);
  const settings = await createColorTemplate(input, [left / width, top / height, markWidth / width, markHeight / height]);
  const result = await removeKnownWatermark(input, Buffer.from(settings.template, 'base64'), { ...settings, padding: 1 });
  assert.equal(result.status, 'processed', JSON.stringify(result));
  assert.ok(Math.abs(result.region.x - left) <= 5);
  assert.ok(Math.abs(result.region.y - top) <= 5);
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.width, width); assert.equal(meta.height, height);
  // The untouched top-left region must not be altered by the bounded-ROI path.
  const unaffected = { left: 0, top: 0, width: 32, height: 32 };
  assert.deepEqual(
    await sharp(result.bytes).extract(unaffected).ensureAlpha().raw().toBuffer(),
    await sharp(input).extract(unaffected).ensureAlpha().raw().toBuffer(),
  );
  assert.deepEqual(input, original);
});
