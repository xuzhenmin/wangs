import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { encodeWatermarkOutput, removeAndBrandWatermark, removeKnownWatermark, validateSettings } from '../scripts/watermark-engine.mjs';
import { OUTPUT_FIXTURE_WIDTH, OUTPUT_FIXTURE_HEIGHT, outputNoise as noise, largeJpegFixture } from './fixtures/watermark-output.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const width = OUTPUT_FIXTURE_WIDTH, height = OUTPUT_FIXTURE_HEIGHT;
const info = { width, height, channels: 4 };
const hash = value => createHash('sha256').update(value).digest('hex');

// These tests never load user media, templates, databases or OSS credentials.

test('oversized output stays opt-in: default and false reject without changing pixels', async () => {
  const data = noise(), original = hash(data);
  assert.ok((await sharp(data, { raw: info }).png().toBuffer()).length > MAX_BYTES);
  await assert.rejects(encodeWatermarkOutput(data, info), /超过 8 MB.*超大结果压缩/);
  await assert.rejects(encodeWatermarkOutput(data, info, false), /超过 8 MB.*超大结果压缩/);
  assert.equal(hash(data), original);
});

test('explicit compression encodes opaque output as same-size high-quality JPEG under 8 MiB', async () => {
  const data = noise(), original = hash(data);
  const result = await encodeWatermarkOutput(data, info, true);
  assert.equal(result.output.format, 'jpeg');
  assert.equal(result.output.lossy, true);
  assert.ok([92, 86, 80].includes(result.output.quality));
  assert.equal(result.output.width, width); assert.equal(result.output.height, height);
  assert.equal(result.output.byteLength, result.bytes.length);
  assert.ok(result.bytes.length > 0 && result.bytes.length <= MAX_BYTES);
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, width); assert.equal(meta.height, height);
  assert.equal(meta.chromaSubsampling, '4:4:4');
  assert.equal(hash(data), original);
});

test('transparent oversized output uses WebP and preserves the entire alpha channel', async () => {
  const data = noise(true), original = hash(data);
  assert.ok((await sharp(data, { raw: info }).png().toBuffer()).length > MAX_BYTES);
  const result = await encodeWatermarkOutput(data, info, true);
  assert.equal(result.output.format, 'webp'); assert.equal(result.output.lossy, true);
  assert.ok(result.bytes.length <= MAX_BYTES);
  assert.equal(result.output.byteLength, result.bytes.length);
  const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, width); assert.equal(decoded.info.height, height);
  for (let p = 3; p < data.length; p += 4) assert.equal(decoded.data[p], data[p]);
  assert.equal(hash(data), original);
});

test('small output remains lossless PNG even when compression is enabled', async () => {
  const smallInfo = { width: 80, height: 40, channels: 4 };
  const data = Buffer.alloc(smallInfo.width * smallInfo.height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = p % 251; data[p + 1] = 135; data[p + 2] = 45; data[p + 3] = (p / 4) % 256;
  }
  const original = Buffer.from(data);
  const defaultResult = await encodeWatermarkOutput(data, smallInfo);
  const optedInResult = await encodeWatermarkOutput(data, smallInfo, true);
  assert.equal(optedInResult.output.format, 'png');
  assert.equal(optedInResult.output.lossy, false);
  assert.equal(optedInResult.output.quality, undefined);
  assert.deepEqual(defaultResult.bytes, optedInResult.bytes);
  assert.deepEqual(await sharp(optedInResult.bytes).ensureAlpha().raw().toBuffer(), original);
  assert.deepEqual(data, original);
});

test('non-boolean compression settings are rejected before decoding or processing', async () => {
  const settings = { relativeWidth: 0.25, mode: 'inpaint', search: 'bottom-right', opacity: 1, threshold: 0.86, padding: 1 };
  for (const value of ['true', 'false', 0, 1, null, {}, []]) {
    const invalid = { ...settings, allowLossyOutput: value };
    assert.throws(() => validateSettings(invalid), /压缩选项无效/);
    await assert.rejects(removeKnownWatermark(Buffer.alloc(0), Buffer.alloc(0), invalid), /压缩选项无效/);
    await assert.rejects(removeAndBrandWatermark(Buffer.alloc(0), Buffer.alloc(0), invalid), /压缩选项无效/);
  }
  for (const value of [undefined, false, true]) validateSettings({ ...settings, allowLossyOutput: value });
});

test('repair and branding encode the final high-entropy image without an intermediate 8 MiB failure', async () => {
  const { input, template, settings, width, height } = await largeJpegFixture();
  const original = hash(input);
  assert.ok(input.length < MAX_BYTES, 'compressed source itself must respect the input limit');
  assert.ok((await sharp(input).png().toBuffer()).length > MAX_BYTES, 'decoded source must overflow lossless output');
  await assert.rejects(removeKnownWatermark(input, template, settings), /超过 8 MB/);
  const result = await removeAndBrandWatermark(input, template, { ...settings, allowLossyOutput: true });
  assert.equal(result.status, 'processed', result.reason);
  assert.equal(result.output.format, 'jpeg'); assert.equal(result.output.lossy, true);
  assert.ok(result.bytes.length <= MAX_BYTES);
  assert.equal(result.platformWatermark.text, '深巷');
  assert.equal(result.platformWatermark.transparencyPercent, 30);
  assert.match(result.reason, /有损压缩/);
  assert.equal(result.data, undefined); assert.equal(result.info, undefined);
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.width, width); assert.equal(meta.height, height);
  assert.equal(hash(input), original);
});
