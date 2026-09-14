import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadVideo } from '../lib/video-download.mjs';

const execute = promisify(execFile);
function toolPath(name) {
  return process.env[name === 'ffmpeg' ? 'VIDEO_FFMPEG_PATH' : 'VIDEO_FFPROBE_PATH'] ||
    ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(directory => path.join(directory, name)).find(existsSync) || name;
}
const ffmpeg = toolPath('ffmpeg'), ffprobe = toolPath('ffprobe');
const toolOptions = { timeout: 30000, maxBuffer: 1024 * 1024 };

// Optional integration test: only self-generated color/audio samples are used.
// The injected resource reader cannot issue a network request; production's actual
// FFmpeg / ffprobe command path and offline muxing remain in use.
test('real FFmpeg imports locally generated AES-128 HLS with explicit and sequence IVs', { timeout: 120000 }, async t => {
  try {
    await execute(ffmpeg, ['-version'], toolOptions);
    await execute(ffprobe, ['-version'], toolOptions);
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes(error.code)) {
      t.skip('FFmpeg and ffprobe must be installed for this optional integration test.');
      return;
    }
    throw error;
  }

  for (const explicitIV of [true, false]) {
    await t.test(explicitIV ? 'explicit 128-bit IV' : 'implicit IV from nonzero media sequence', async t => {
      const directory = await mkdtemp(path.join(tmpdir(), 'wangs-video-aes-fixture-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const source = path.join(directory, 'source'), output = path.join(directory, 'output');
      await mkdir(source); await mkdir(output);
      const keyPath = path.join(source, 'crypt.key');
      const key = randomBytes(16);
      await writeFile(keyPath, key, { mode: 0o600 });
      const token = 'SYNTHETIC_FIXTURE_TOKEN';
      const keyInfo = path.join(source, 'key-info.txt');
      const iv = '00000000000000000000000000000011';
      await writeFile(keyInfo, `https://fixture.example/crypt.key?token=${token}\n${keyPath}\n${explicitIV ? `${iv}\n` : ''}`, { mode: 0o600 });
      const playlistPath = path.join(source, 'list.m3u8');
      await execute(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-threads', '1', '-g', '25', '-sc_threshold', '0', '-c:a', 'aac', '-ac', '1', '-b:a', '64k',
        '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-start_number', '7',
        '-hls_key_info_file', keyInfo, '-hls_segment_filename', path.join(source, 'segment-%d.ts'), playlistPath,
      ], toolOptions);
      let playlist = await readFile(playlistPath, 'utf8');
      assert.match(playlist, /#EXT-X-KEY:METHOD=AES-128/);
      assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:7/);
      if (explicitIV) assert.match(playlist, new RegExp(`IV=0x${iv}`, 'i'));
      else {
        // FFmpeg spells out its automatically calculated per-segment IVs. Removing
        // those attributes exercises the equivalent RFC media-sequence fallback.
        playlist = playlist.replace(/,IV=0x[\da-f]+/gi, '');
        assert.doesNotMatch(playlist, /IV=/);
      }
      const sourceFiles = new Set(await readdir(source));
      const keyBuffers = [];
      const stages = [];
      const result = await downloadVideo(`https://fixture.example/list.m3u8?token=${token}`, output, {
        signal: AbortSignal.timeout(30000), progress: patch => stages.push(patch.status),
        fetcher: async (value, options) => {
          options.signal.throwIfAborted();
          const url = new URL(value);
          assert.equal(url.origin, 'https://fixture.example');
          const filename = url.pathname.slice(1);
          assert.ok(sourceFiles.has(filename), `Unexpected synthetic resource: ${filename}`);
          assert.equal(filename, path.basename(filename));
          const bytes = filename === 'list.m3u8' ? Buffer.from(playlist) : Buffer.from(await readFile(path.join(source, filename)));
          assert.ok(bytes.length <= options.maxBytes);
          options.onBytes(bytes.length);
          if (filename === 'crypt.key') keyBuffers.push(bytes);
          return { bytes, url: url.href };
        },
      });
      assert.equal(result.downloaded, 2); assert.equal(result.total, 2);
      assert.ok(Math.abs(result.duration - 2) < 0.15, `Unexpected duration: ${result.duration}`);
      assert.ok(stages.includes('downloading')); assert.ok(stages.includes('muxing')); assert.ok(stages.includes('verifying'));
      assert.ok(keyBuffers.length > 0);
      assert.ok(keyBuffers.every(buffer => buffer.every(byte => byte === 0)), 'Task clears fetched key buffers');
      assert.deepEqual(await readFile(keyPath), key, 'Fixture key stays intact when task clears its own buffers');
      const outputFiles = await readdir(output);
      assert.deepEqual(outputFiles.sort(), ['output.partial.mp4', 'track-0-0.ts', 'track-0-1.ts', 'track-0.m3u8']);
      const offline = await readFile(path.join(output, 'track-0.m3u8'), 'utf8');
      assert.doesNotMatch(offline, /#EXT-X-(?:SESSION-)?KEY|https?:|URI=|crypt\.key|SYNTHETIC_FIXTURE_TOKEN/);
      const mp4 = path.join(output, 'output.partial.mp4');
      assert.ok((await stat(mp4)).size > 1000);
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', mp4], toolOptions);
      const metadata = JSON.parse(stdout);
      assert.ok(metadata.streams.some(stream => stream.codec_type === 'video' && stream.width === 160 && stream.height === 90));
      assert.ok(metadata.streams.some(stream => stream.codec_type === 'audio'));
      assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.15);
      // Decode every frame and audio packet, not just the container header.
      await execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', mp4, '-f', 'null', '-'], toolOptions);
    });
  }
});
