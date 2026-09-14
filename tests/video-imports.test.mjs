import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { publicIPv4, sourceURL, parsePlaylist, downloadVideo, fetchResource, segmentExtension, VideoError, LIMITS, command, requestFailure } from '../lib/video-download.mjs';
import { validateBatch } from '../lib/video-imports.mjs';

const base = 'https://media.example/video/list.m3u8?auth_key=SECRET';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts?token=SECRET\n#EXT-X-ENDLIST\n';
const ts = Buffer.alloc(188 * 2); ts[0] = 0x47; ts[188] = 0x47;

test('public IP and URL policy rejects loopback, special ranges, IPv6, credentials and non-HTTP', () => {
  for (const ip of ['0.0.0.0', '127.0.0.1', '10.3.2.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '198.18.1.1', '224.1.1.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'http://127.1/x', 'http://2130706433/x', 'http://[::1]/x', 'http://u:p@example.com/x', 'http://example.com:8080/x', 'http://localhost/x']) assert.throws(() => sourceURL(url), VideoError, url);
  assert.equal(sourceURL('../a.ts', base).href, 'https://media.example/a.ts');
});

test('batch validation limits count, requires authorization and does not allow local or invalid backup sources', () => {
  assert.throws(() => validateBatch({ authorized: false, videos: [{ url: base }] }), /有权/);
  assert.throws(() => validateBatch({ authorized: true, videos: Array(7).fill({ url: base }) }), /1–6/);
  assert.throws(() => validateBatch({ authorized: true, videos: [{ url: base, backupUrl: 'http://127.0.0.1/key' }] }), /公网/);
  assert.equal(validateBatch({ authorized: true, videos: [{ url: base }] })[0].sourceHost, 'media.example');
});

test('media parser resolves relative signed resources without inventing inherited query parameters', () => {
  const result = parsePlaylist(media, base);
  assert.equal(result.kind, 'media'); assert.equal(result.duration, 2);
  assert.deepEqual(result.resources, ['https://media.example/video/segment.ts?token=SECRET']);
  assert.equal(parsePlaylist(media.replace('segment.ts?token=SECRET', 'segment.ts'), base).resources[0], 'https://media.example/video/segment.ts');
});

test('master selects highest bandwidth and matching default external audio', () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="aud"\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8';
  const result = parsePlaylist(master, base);
  assert.equal(result.url, 'https://media.example/video/high.m3u8');
  assert.equal(result.audio, 'https://media.example/video/audio.m3u8');
});

test('unsupported or malicious manifests fail closed', () => {
  for (const bad of [
    '<html>denied</html>', media.replace('#EXT-X-ENDLIST', ''),
    media.replace('#EXTINF:', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:'),
    media.replace('#EXTINF:', '#EXT-X-BYTERANGE:100@0\n#EXTINF:'),
    media.replace('#EXTINF:', '#EXT-X-MAP:URI="http://169.254.169.254/key"\n#EXTINF:'),
    media.replace('segment.ts?token=SECRET', 'file:///etc/passwd'),
    media.replace('#EXTINF:2,', '#EXTINF:NaN,'),
    media.replace('#EXTINF:2,', '#EXTINF:9000,'),
    media.replace('#EXTINF:', '#EXT-X-DEFINE:NAME="x",VALUE="a"\n#EXTINF:'),
    media.replace('#EXTINF:', '#EXT-X-UNKNOWN:URI="file:///secret"\n#EXTINF:'),
  ]) assert.throws(() => parsePlaylist(bad, base), VideoError);
  assert.equal(parsePlaylist(media.replace('#EXTINF:', '#EXT-X-KEY:METHOD=NONE\n#EXTINF:'), base).kind, 'media');
});

test('segment signature validation rejects HTML and nested playlists before FFmpeg', () => {
  assert.equal(segmentExtension(ts), 'ts');
  assert.equal(segmentExtension(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'aac');
  assert.equal(segmentExtension(Buffer.from('\x00\x00\x00\x18ftypisom')), 'mp4');
  for (const value of ['#EXTM3U\nfile:///etc/passwd', '<html>403</html>', 'garbage']) assert.throws(() => segmentExtension(Buffer.from(value)), /分片不是/);
});

test('network boundary rejects mixed DNS, checks redirects and pins connections', async t => {
  const options = { signal: new AbortController().signal, maxBytes: 1000, resolver: async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }] };
  await assert.rejects(fetchResource('http://media.example/a', options), /非公网/);
  let calls = 0;
  t.mock.method(http, 'get', (url, config, callback) => {
    calls++;
    config.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
    assert.equal(config.agent, false);
    assert.equal(config.headers.Cookie, undefined);
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
    queueMicrotask(() => {
      const response = Readable.from([Buffer.from('test')]);
      response.statusCode = 302; response.headers = { location: 'http://127.0.0.1/secret' }; callback(response);
    });
    return request;
  });
  await assert.rejects(fetchResource('http://media.example/a', { ...options, resolver: async () => [{ address: '8.8.8.8' }] }), /公网/);
  assert.equal(calls, 1);
});

test('network response caps size, redacts errors and accepts pinned public responses', async t => {
  const options = { signal: new AbortController().signal, maxBytes: 3, resolver: async () => [{ address: '8.8.8.8' }] };
  let status = 200;
  t.mock.method(http, 'get', (_url, _config, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
    queueMicrotask(() => {
      const response = Readable.from([Buffer.from('1234')]); response.statusCode = status; response.headers = {}; callback(response);
    });
    return request;
  });
  await assert.rejects(fetchResource('http://media.example/a?token=SECRET', options), /大小限制/);
  status = 403;
  await assert.rejects(fetchResource('http://media.example/a?token=SECRET', options), error => /HTTP 403/.test(error.message) && !error.message.includes('SECRET'));
  status = 200;
  assert.equal((await fetchResource('http://media.example/a', { ...options, maxBytes: 4 })).bytes.toString(), '1234');
});

test('Node real HTTP connection accepts pinned DNS in single-address and all-address modes', async t => {
  const server = http.createServer((_request, response) => response.end('fixture'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const original = http.get;
  const realModes = [];
  let useAutoFamily = false;
  t.mock.method(http, 'get', (url, config, callback) => {
    assert.equal(config.family, 4, 'production explicitly limits to validated IPv4');
    // Exercise Node's actual socket connection and lookup callback contract. Only this
    // test transport maps the asserted public IP to a local fixture, never production.
    const local = new URL(url); local.port = String(server.address().port);
    return original(local, {
      ...config, ...(useAutoFamily ? { family: 0, autoSelectFamily: true } : {}),
      lookup: (hostname, options, done) => {
        realModes.push(Boolean(options.all));
        config.lookup(hostname, options, (error, address, family) => {
          try {
            assert.equal(error, null);
            if (options.all) {
              assert.deepEqual(address, [{ address: '8.8.8.8', family: 4 }]);
              done(null, [{ address: '127.0.0.1', family: 4 }]);
            } else {
              assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
              done(null, '127.0.0.1', 4);
            }
          } catch (failure) { done(failure); }
        });
      },
    }, callback);
  });
  const options = { signal: AbortSignal.timeout(3000), maxBytes: 1024, resolver: async () => [{ address: '8.8.8.8', family: 4 }] };
  assert.equal((await fetchResource('http://fixture.example/list', options)).bytes.toString(), 'fixture');
  useAutoFamily = true;
  assert.equal((await fetchResource('http://fixture.example/list', options)).bytes.toString(), 'fixture');
  assert.deepEqual(realModes, [false, true]);
});

test('network errors distinguish address, TLS, cancellation and transport failures without leaking URLs', () => {
  const raw = 'request https://private.example/list?auth_key=SECRET';
  for (const [code, pattern] of [
    ['ERR_INVALID_IP_ADDRESS', /地址解析结果格式/], ['CERT_HAS_EXPIRED', /证书验证失败/],
    ['ECONNRESET', /网络连接失败（ECONNRESET）/], ['ABORT_ERR', /请求已取消/],
  ]) {
    const result = requestFailure(Object.assign(new Error(raw), { code }));
    assert.match(result.message, pattern); assert.ok(!result.message.includes('SECRET'));
  }
  assert.ok(!requestFailure(Object.assign(new Error(raw), { code: raw })).message.includes('SECRET'));
});

test('download pipeline rewrites manifests offline, emits stages and validates output', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-pipeline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stages = []; const commands = [];
  const result = await downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: patch => stages.push(patch.status),
    fetcher: async (url, options) => {
      const bytes = url === base ? Buffer.from(media) : ts;
      options.onBytes(bytes.length); return { bytes, url };
    },
    run: async (_binary, args) => {
      commands.push(args);
      assert.ok(!args.some(arg => /https?:|SECRET/.test(arg)), 'FFmpeg never receives external URLs or tokens');
      assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
      if (args.includes('-show_streams')) return JSON.stringify({ format: { duration: '2.0' }, streams: [{ codec_type: 'video' }] });
      const rewritten = await readFile(args[args.indexOf('-i') + 1], 'utf8');
      assert.ok(!/https?:|SECRET/.test(rewritten)); assert.match(rewritten, /track-0-0.ts/);
      await writeFile(args.at(-1), 'synthetic-output'); return '';
    },
  });
  assert.equal(result.duration, 2); assert.equal(result.downloaded, 1); assert.equal(commands.length, 2);
  assert.deepEqual(stages, ['downloading', 'muxing', 'verifying']);
});

test('download pipeline handles fMP4 initialization and separate audio safely', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nvideo.m3u8';
  const mapped = media.replace('#EXTINF:', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:');
  await downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: () => {},
    fetcher: async (url, options) => {
      const bytes = url === base ? Buffer.from(master) : url.endsWith('.m3u8') ? Buffer.from(mapped) : url.endsWith('init.mp4') ? Buffer.from('\x00\x00\x00\x18ftypisom') : ts;
      options.onBytes(bytes.length); return { bytes, url };
    },
    run: async (_binary, args) => {
      if (args.includes('-show_streams')) return JSON.stringify({ format: { duration: 2 }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] });
      assert.equal(args.filter(arg => arg === '-i').length, 2); assert.ok(args.includes('1:a:0'));
      const text = await readFile(args[args.indexOf('-i') + 1], 'utf8'); assert.match(text, /URI="track-0-0.mp4"/);
      return '';
    },
  });
});

test('quota, cancellation, retry limits and invalid duration stop task', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-failures-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const common = { signal: new AbortController().signal, progress: () => {} };
  await assert.rejects(downloadVideo(base, directory, { ...common, signal: AbortSignal.abort() }));
  await assert.rejects(downloadVideo(base, directory, { ...common, fetcher: async (_url, options) => { options.onBytes(LIMITS.bytes + 1); } }), /1 GiB/);
  let attempts = 0;
  await assert.rejects(downloadVideo(base, directory, { ...common, fetcher: async () => { attempts++; throw new VideoError('网络连接失败'); } }), /网络/);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(downloadVideo(base, directory, { ...common, fetcher: async () => { attempts++; throw new VideoError('HTTP 403'); } }), /403/);
  assert.equal(attempts, 1);
  await assert.rejects(downloadVideo(base, directory, {
    ...common, fetcher: async url => ({ url, bytes: url === base ? Buffer.from(media) : ts }),
    run: async (_binary, args) => args.includes('-show_streams') ? JSON.stringify({ format: { duration: 50 }, streams: [{ codec_type: 'video' }] }) : '',
  }), /校验失败/);
});

test('child tool failure and abort return safe actionable errors', async () => {
  await assert.rejects(command('/definitely-missing-ffmpeg', ['-version'], AbortSignal.timeout(2000)), /手动安装/);
  assert.equal(await command(process.execPath, ['-e', 'process.stdout.write("ok")'], AbortSignal.timeout(2000)), 'ok');
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], AbortSignal.timeout(20)), /取消|时限/);
});
