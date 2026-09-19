import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  createColorTemplate,
  createYellowTemplate,
  removeAndBrandWatermark,
  removeKnownWatermark,
  validateSettings,
  validateWatermarkTemplate,
} from '../scripts/watermark-engine.mjs';
import { outlineFixture } from './fixtures/watermark-outline.mjs';

const decode = input => sharp(input).ensureAlpha().raw().toBuffer();

test('outlined extraction retains slanted multiline yellow strokes and nearby dark outlines only', async () => {
  const f = await outlineFixture(), original = Buffer.from(f.input);
  const settings = await createColorTemplate(f.input, f.region, 'yellow-outline', 4);
  assert.equal(settings.extractionColor, 'yellow-outline');
  assert.equal(settings.search, 'bottom');
  assert.equal(settings.mode, 'inpaint');
  assert.equal(settings.padding, 1);
  assert.equal(settings.outlineRadius, 4);
  assert.equal(settings.relativeWidth, f.tw / f.width);
  const template = Buffer.from(settings.template, 'base64');
  await validateWatermarkTemplate(template);
  const meta = await sharp(template).metadata(), rgba = await decode(template);
  assert.equal(meta.width, f.tw); assert.equal(meta.height, f.th);
  let yellowCount = 0, darkCount = 0;
  for (let y = 0; y < f.th; y++) for (let x = 0; x < f.tw; x++) {
    const i = y * f.tw + x, p = i * 4;
    assert.equal(rgba[p + 3], f.dark[i] ? 255 : 0, `mask mismatch at ${x},${y}`);
    if (!f.dark[i]) continue;
    const source = ((f.top + y) * f.width + f.left + x) * 4;
    assert.deepEqual(rgba.subarray(p, p + 3), f.raw.subarray(source, source + 3));
    if (f.yellow[i]) yellowCount++; else darkCount++;
  }
  assert.ok(yellowCount >= 80 && darkCount > yellowCount);
  // Two rows retain their original lean, with no automatic straightening.
  for (const [x, y] of [[18, 32], [18, 73], [261, 19], [261, 60]]) assert.equal(rgba[(y * f.tw + x) * 4 + 3], 255);
  for (let y = 3; y < 10; y++) for (let x = 3; x < 10; x++) assert.equal(rgba[(y * f.tw + x) * 4 + 3], 0);
  assert.deepEqual(f.input, original);
});

test('bottom-wide search locates a centered wide outline watermark excluded by old bottom-right search', async () => {
  const f = await outlineFixture();
  const settings = await createColorTemplate(f.input, f.region, 'yellow-outline');
  const template = Buffer.from(settings.template, 'base64');
  const result = await removeKnownWatermark(f.input, template, settings);
  assert.equal(result.status, 'processed', JSON.stringify(result));
  assert.ok(result.confidence >= 0.99);
  assert.deepEqual(result.region, { x: f.left, y: f.top, width: f.tw, height: f.th });
  const oldSearch = await removeKnownWatermark(f.input, template, { ...settings, search: 'bottom-right' });
  assert.equal(oldSearch.status, 'skipped');
  assert.equal(oldSearch.bytes, undefined);
  const plain = await sharp(f.original, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toBuffer();
  const absent = await removeKnownWatermark(plain, template, settings);
  assert.equal(absent.status, 'skipped');
  assert.equal(absent.bytes, undefined);
});

test('joint mask removes dark edges more completely than yellow-only without altering any unmasked pixels', async () => {
  const f = await outlineFixture(), original = Buffer.from(f.input);
  const outlined = await createColorTemplate(f.input, f.region, 'yellow-outline');
  const yellow = await createColorTemplate(f.input, f.region, 'yellow');
  const joint = await removeKnownWatermark(f.input, Buffer.from(outlined.template, 'base64'), outlined);
  const old = await removeKnownWatermark(f.input, Buffer.from(yellow.template, 'base64'), { ...yellow, search: 'bottom', padding: 1 });
  assert.equal(joint.status, 'processed'); assert.equal(old.status, 'processed');
  assert.equal(joint.output.format, 'png'); assert.equal(joint.output.lossy, false);
  const jointRaw = await decode(joint.bytes), oldRaw = await decode(old.bytes);
  const repairMask = new Uint8Array(f.width * f.height);
  for (let y = 0; y < f.th; y++) for (let x = 0; x < f.tw; x++) {
    if (!f.dark[y * f.tw + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) repairMask[(f.top + y + dy) * f.width + f.left + x + dx] = 1;
  }
  let oldDarkError = 0, jointDarkError = 0;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const i = y * f.width + x, p = i * 4;
    if (!repairMask[i]) assert.deepEqual(jointRaw.subarray(p, p + 4), f.raw.subarray(p, p + 4));
    assert.equal(jointRaw[p + 3], f.raw[p + 3]);
    const local = (y - f.top) * f.tw + x - f.left;
    if (x >= f.left && x < f.left + f.tw && y >= f.top && y < f.top + f.th && f.dark[local] && !f.yellow[local]) {
      for (let c = 0; c < 3; c++) {
        oldDarkError += Math.abs(oldRaw[p + c] - f.original[p + c]);
        jointDarkError += Math.abs(jointRaw[p + c] - f.original[p + c]);
      }
    }
  }
  assert.ok(oldDarkError > 10_000);
  assert.ok(jointDarkError < oldDarkError * 0.05, `${jointDarkError} vs ${oldDarkError}`);
  assert.ok(joint.repairedPixels > old.repairedPixels * 2);
  assert.deepEqual(f.input, original);
});

test('transparent or saturated dark neighbors are not included in the outline mask', async () => {
  const f = await outlineFixture(), raw = Buffer.from(f.raw);
  const outlinePixels = [...f.dark.keys()].filter(i => f.dark[i] && !f.yellow[i]);
  const yellowPixel = f.yellow.findIndex(Boolean);
  const [transparentDark, blueDark] = outlinePixels;
  const imagePixel = i => ((f.top + Math.floor(i / f.tw)) * f.width + f.left + i % f.tw) * 4;
  raw[imagePixel(transparentDark) + 3] = 0;
  raw[imagePixel(yellowPixel) + 3] = 0;
  raw[imagePixel(blueDark)] = 0; raw[imagePixel(blueDark) + 1] = 0; raw[imagePixel(blueDark) + 2] = 110;
  const input = await sharp(raw, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toBuffer();
  const settings = await createColorTemplate(input, f.region, 'yellow-outline');
  const rgba = await decode(Buffer.from(settings.template, 'base64'));
  for (const i of [transparentDark, yellowPixel, blueDark]) assert.equal(rgba[i * 4 + 3], 0);
});

test('outline distance is bounded; legacy yellow and black extraction defaults remain intact', async () => {
  const f = await outlineFixture();
  const close = await createColorTemplate(f.input, f.region, 'yellow-outline', 1);
  const wide = await createColorTemplate(f.input, f.region, 'yellow-outline', 4);
  const count = pixels => pixels.reduce((sum, v, i) => sum + (i % 4 === 3 && v > 0 ? 1 : 0), 0);
  assert.ok(count(await decode(Buffer.from(close.template, 'base64'))) < count(await decode(Buffer.from(wide.template, 'base64'))));
  const legacy = await createYellowTemplate(f.input, f.region);
  assert.deepEqual(await createColorTemplate(f.input, f.region), legacy);
  assert.deepEqual(await createColorTemplate(f.input, f.region, 'yellow'), legacy);
  for (const color of ['yellow', 'black']) {
    const settings = await createColorTemplate(f.input, f.region, color);
    assert.equal(settings.search, 'bottom-right'); assert.equal(settings.padding, 6);
    assert.equal(settings.outlineRadius, undefined);
    assert.doesNotThrow(() => validateSettings({ ...settings, mode: 'inverse' }));
  }
});

test('outline extraction rejects weak, fully colored or background-ambiguous selections', async () => {
  for (const background of ['#b0b0b0', '#ffb400']) {
    const input = await sharp({ create: { width: 100, height: 40, channels: 4, background } }).png().toBuffer();
    await assert.rejects(createColorTemplate(input, [0, 0, 1, 1], 'yellow-outline'), /可靠的黄色/);
  }
  const width = 100, height = 40, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    raw[p + 3] = 255;
    if (x % 4 === 1) { raw[p] = 255; raw[p + 1] = 180; }
  }
  const input = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await assert.rejects(createColorTemplate(input, [0, 0, 1, 1], 'yellow-outline'), /描边与背景难以区分/);
});

test('invalid outline settings fail closed and joint masks cannot use inverse blending', async () => {
  const f = await outlineFixture();
  const settings = await createColorTemplate(f.input, f.region, 'yellow-outline');
  for (const radius of [0, 13, -1, 1.5, NaN, '4', null]) {
    await assert.rejects(createColorTemplate(f.input, f.region, 'yellow-outline', radius), /描边检测范围/);
    assert.throws(() => validateSettings({ ...settings, outlineRadius: radius }), /描边检测范围/);
  }
  await assert.rejects(createColorTemplate(f.input, f.region, 'outline'), /颜色/);
  assert.throws(() => validateSettings({ ...settings, search: 'bottom-left' }), /模式/);
  assert.throws(() => validateSettings({ ...settings, mode: 'inverse' }), /仅支持.*修补/);
  await assert.rejects(removeKnownWatermark(f.input, Buffer.from(settings.template, 'base64'), { ...settings, mode: 'inverse' }), /不支持半透明反向混合/);
});

test('outlined templates also pass through repair-plus-brand while keeping the source unchanged', async () => {
  const f = await outlineFixture(), before = Buffer.from(f.input);
  const settings = await createColorTemplate(f.input, f.region, 'yellow-outline');
  const result = await removeAndBrandWatermark(f.input, Buffer.from(settings.template, 'base64'), settings);
  assert.equal(result.status, 'processed');
  assert.equal(result.platformWatermark.text, '深巷');
  assert.equal(result.platformWatermark.transparencyPercent, 30);
  assert.equal(result.output.width, f.width); assert.equal(result.output.height, f.height);
  assert.equal(result.output.lossy, false);
  assert.deepEqual(f.input, before);
});
