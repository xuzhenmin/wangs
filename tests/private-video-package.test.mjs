import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { packagePrivateVideo } from '../scripts/private-video-package.mjs';
import { loadTs } from './helpers/load-typescript.mjs';

const { validatePrivateVideoManifest } = loadTs('../lib/private-videos.ts', import.meta.url);
const execute = promisify(execFile);
const tool = name => process.env[name === 'ffmpeg' ? 'VIDEO_FFMPEG_PATH' : 'VIDEO_FFPROBE_PATH'] ||
  ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(directory => path.join(directory, name)).find(existsSync) || name;
const commandOptions = { timeout: 30000, maxBuffer: 1024 * 1024 };

test('packager rejects incompatible codecs, oversized durations and cancellation before creating output', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-package-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic.mp4'); await writeFile(file, Buffer.alloc(64));
  const metadata = { streams: [{ codec_type: 'video', codec_name: 'vp9' }], format: { duration: '4' } };
  const run = async () => JSON.stringify(metadata);
  await assert.rejects(packagePrivateVideo(file, { run }), /H.264/);
  metadata.streams[0].codec_name = 'h264'; metadata.streams.push({ codec_type: 'audio', codec_name: 'opus' });
  await assert.rejects(packagePrivateVideo(file, { run }), /AAC/);
  metadata.streams.pop(); metadata.format.duration = '7201';
  await assert.rejects(packagePrivateVideo(file, { run }), /2 小时/);
  metadata.format.duration = 'NaN';
  await assert.rejects(packagePrivateVideo(file, { run }), /时长/);
  await assert.rejects(packagePrivateVideo(file, { signal: AbortSignal.abort() }), /取消|打包/);
  assert.equal((await stat(file)).size, 64);
});

test('real FFmpeg encrypts synthetic H264/AAC as standard HLS, playback decrypts, and all key material is cleaned', { timeout: 120000 }, async t => {
  try { await execute(tool('ffmpeg'), ['-version'], commandOptions); await execute(tool('ffprobe'), ['-version'], commandOptions); }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) { t.skip('FFmpeg and ffprobe required for optional integration test.'); return; } throw error; }
  const directory = await mkdtemp(path.join(tmpdir(), 'private-package-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic.mp4');
  await execute(tool('ffmpeg'), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1', '-g', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '1', '-b:a', '64k', file], commandOptions);
  const originalHash = createHash('sha256').update(await readFile(file)).digest('hex');
  const packaged = await packagePrivateVideo(file, { timeoutMs: 30000 });
  t.after(() => packaged.cleanup());
  const parsed = validatePrivateVideoManifest(packaged.manifest);
  assert.equal(parsed.segments.length, 2);
  assert.ok(Math.abs(parsed.duration - 8) < 0.15);
  assert.equal((await stat(packaged.directory)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(packaged.directory)).sort(), ['index.m3u8', 'segment-00000.ts', 'segment-00001.ts']);
  const key = Buffer.from(packaged.key), iv = Buffer.from(packaged.manifest.match(/IV=0x([0-9a-f]{32})/i)[1], 'hex');
  for (const segment of packaged.segments) {
    const encrypted = await readFile(segment.file);
    assert.equal(encrypted.length % 16, 0);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    assert.equal(plaintext[0], 0x47); assert.equal(plaintext[188], 0x47);
    assert.notDeepEqual(encrypted.subarray(0, 188), plaintext.subarray(0, 188));
    assert.equal((await stat(segment.file)).mode & 0o777, 0o600);
  }
  // Restore a key ONLY for this generated non-sensitive fixture to exercise actual standards-compliant playback.
  await writeFile(path.join(packaged.directory, 'key.bin'), key, { mode: 0o600 });
  await execute(tool('ffmpeg'), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-protocol_whitelist', 'file,crypto', '-allowed_extensions', 'ALL', '-i', path.join(packaged.directory, 'index.m3u8'), '-f', 'null', '-'], commandOptions);
  await packaged.cleanup();
  assert.equal(existsSync(packaged.directory), false);
  assert.ok(packaged.key.every(byte => byte === 0));
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), originalHash);
  key.fill(0);
});
