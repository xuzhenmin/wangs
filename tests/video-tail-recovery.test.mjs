import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv } from 'node:crypto';
import { downloadVideo, recoverVideoTail, VideoError, VideoTailError } from '../lib/video-download.mjs';

const base = 'https://media.example/list.m3u8?auth_key=SECRET';
const ts = Buffer.alloc(376); ts[0] = 0x47; ts[188] = 0x47;
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n0.ts\n#EXTINF:2,\n1.ts\n#EXTINF:2,\n2.ts\n#EXT-X-ENDLIST\n';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-tail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const signal = () => new AbortController().signal;
async function pending(directory, options = {}) {
  let captured;
  await assert.rejects(downloadVideo(base, directory, {
    signal: signal(), progress() {}, run: async () => { throw new Error('must await confirmation'); },
    fetcher: async url => {
      if (new URL(url).pathname.endsWith('/2.ts')) throw new VideoError('网络连接失败（ECONNRESET）。');
      return { url, bytes: url === base ? Buffer.from(media) : ts };
    }, ...options,
  }), error => { captured = error; return error instanceof VideoTailError; });
  return captured;
}
const recordPath = directory => path.join(directory, 'tail-recovery.json');

test('only final failure pauses for confirmation; retained checkpoint is local, secret-free and shortened', async t => {
  const directory = await fixture(t), error = await pending(directory);
  assert.equal(error.recovery.downloaded, 2); assert.equal(error.recovery.total, 3);
  assert.equal(error.recovery.missingSeconds, 2); assert.equal(error.recovery.keptDuration, 4);
  const raw = await readFile(recordPath(directory), 'utf8');
  assert.doesNotMatch(raw, /SECRET|auth_key|https?:|EXT-X-KEY|key\.bin/);
  const record = JSON.parse(raw);
  assert.equal((record.playlist.match(/EXTINF/g) || []).length, 2);
  assert.match(record.playlist, /#EXT-X-ENDLIST\n$/);
  assert.deepEqual((await readdir(directory)).sort(), ['tail-recovery.json', 'track-0-0.ts', 'track-0-1.ts']);
  const stages = [], commands = [];
  const result = await recoverVideoTail(directory, { signal: signal(), progress: patch => stages.push(patch.status), run: async (_tool, args) => {
    commands.push(args); assert.ok(!args.some(value => /https?:|SECRET/.test(value)));
    if (args.includes('-show_streams')) return JSON.stringify({ format: { duration: 4 }, streams: [{ codec_type: 'video' }] });
    assert.equal(await readFile(args[args.indexOf('-i') + 1], 'utf8'), record.playlist);
    await writeFile(args.at(-1), 'synthetic-output'); return '';
  } });
  assert.deepEqual(result.incomplete, { missingSegments: 1, missingSeconds: 2, originalDuration: 6 });
  assert.equal(result.duration, 4); assert.equal(commands.length, 2);
  assert.deepEqual(stages, ['muxing', 'verifying']);
});

test('middle/first segments, auth/quota/key errors, cancellation and sole segments never become skippable', async t => {
  for (const scenario of ['middle', 'first', '403', 'quota', 'key', 'cancel', 'sole', 'external-audio']) await t.test(scenario, async t => {
    const directory = await fixture(t), controller = new AbortController();
    const playlist = scenario === 'sole' ? media.replace('#EXTINF:2,\n0.ts\n#EXTINF:2,\n1.ts\n', '')
      : scenario === 'key' ? media.replace('#EXTINF:2,\n2.ts', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\n2.ts') : media;
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nvideo.m3u8';
    await assert.rejects(downloadVideo(base, directory, { signal: controller.signal, progress() {}, fetcher: async url => {
      const name = new URL(url).pathname;
      if (url === base || name.endsWith('.m3u8')) return { url, bytes: Buffer.from(scenario === 'external-audio' && url === base ? master : playlist) };
      if (scenario === 'key' && name.endsWith('key.bin')) throw new VideoError('网络连接失败');
      const target = scenario === 'middle' ? '/1.ts' : scenario === 'first' ? '/0.ts' : '/2.ts';
      if (name.endsWith(target)) {
        if (scenario === 'cancel') { controller.abort(); controller.signal.throwIfAborted(); }
        throw new VideoError(scenario === '403' ? 'HTTP 403：访问被拒绝' : scenario === 'quota' ? '任务下载量超过 1 GiB。' : '网络连接失败');
      }
      return { url, bytes: ts };
    } }), error => !(error instanceof VideoTailError));
    assert.ok(!(await readdir(directory)).includes('tail-recovery.json'));
  });
});

test('corrupt final bytes can be skipped; AES keys and remote URLs are not retained', async t => {
  const directory = await fixture(t), key = Buffer.alloc(16, 3), iv = Buffer.alloc(16, 4);
  const encrypted = (() => { const cipher = createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([cipher.update(ts), cipher.final()]); })();
  const playlist = media.replace('#EXTINF:2,', `#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=SECRET",IV=0x${iv.toString('hex')}\n#EXTINF:2,`);
  await pending(directory, { fetcher: async url => ({ url, bytes: url === base ? Buffer.from(playlist) : url.includes('key.bin') ? key : url.endsWith('/2.ts') ? Buffer.from('broken') : encrypted }) });
  assert.deepEqual(await readFile(path.join(directory, 'track-0-0.ts')), ts);
  assert.doesNotMatch(await readFile(recordPath(directory), 'utf8'), /SECRET|EXT-X-KEY|key\.bin|https?:/);
  assert.ok(key.every(value => value === 0), 'key cache is wiped even when preserving decrypted fragments');
});

test('recovery revalidates content, paths, symlinks, playlist identity and cancellation before FFmpeg', async t => {
  for (const scenario of ['hash', 'path', 'url', 'key', 'symlink', 'duration', 'missing', 'cancel']) await t.test(scenario, async t => {
    const directory = await fixture(t); await pending(directory);
    const record = JSON.parse(await readFile(recordPath(directory), 'utf8'));
    if (scenario === 'hash') await writeFile(path.join(directory, record.files[0].name), Buffer.alloc(376));
    if (scenario === 'path') record.files[0].name = '../secret';
    if (scenario === 'url') record.playlist = record.playlist.replace('track-0-0.ts', 'https://evil.example/x.ts');
    if (scenario === 'key') record.playlist = record.playlist.replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"\n#EXTINF:');
    if (scenario === 'duration') record.keptDuration = 1;
    if (scenario === 'missing' || scenario === 'symlink') {
      await rm(path.join(directory, record.files[0].name));
      if (scenario === 'symlink') await symlink(path.join(directory, record.files[1].name), path.join(directory, record.files[0].name));
    }
    await writeFile(recordPath(directory), JSON.stringify(record));
    let runs = 0;
    await assert.rejects(recoverVideoTail(directory, { signal: scenario === 'cancel' ? AbortSignal.abort() : signal(), progress() {}, run: async () => { runs++; } }));
    assert.equal(runs, 0);
  });
});

test('recovery still rejects missing video tracks and a duration inconsistent with the retained playlist', async t => {
  const directory = await fixture(t); await pending(directory);
  for (const metadata of [{ format: { duration: 4 }, streams: [{ codec_type: 'audio' }] }, { format: { duration: 100 }, streams: [{ codec_type: 'video' }] }]) {
    await assert.rejects(recoverVideoTail(directory, { signal: signal(), progress() {}, run: async (_tool, args) => args.includes('-show_streams') ? JSON.stringify(metadata) : '' }), /输出轨道或时长校验失败/);
  }
});
