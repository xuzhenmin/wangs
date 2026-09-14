import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadVideo, fetchResource, LIMITS, parsePlaylist, VideoError } from '../lib/video-download.mjs';

// Synthetic fixtures only: no external media, credentials or keys are fetched.
const base = 'https://media.example/video/list.m3u8?token=PLAYLIST_SECRET';
const keyURL = 'https://media.example/video/key.bin?token=KEY_SECRET';
const iv = '00112233445566778899aabbccddeeff';
const key = Buffer.from('synthetic-key-01');
const otherKey = Buffer.from('synthetic-key-02');
const ts = Buffer.alloc(188 * 2); ts[0] = 0x47; ts[188] = 0x47;
const mapBytes = Buffer.from('\x00\x00\x00\x18ftypisom');
const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=KEY_SECRET",IV=0x${iv}`;
const segment = name => `#EXTINF:2,\n${name}`;
const playlist = body => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${body}\n#EXT-X-ENDLIST\n`;
const encrypted = (bytes, material = key, vector = iv) => {
  const cipher = createCipheriv('aes-128-cbc', material, Buffer.from(vector, 'hex'));
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};
const urlFor = value => new URL(value, base).href;

async function directoryFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-aes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureFetcher(resources, seen = []) {
  return async (url, options) => {
    seen.push({ url, maxBytes: options.maxBytes });
    assert.ok(resources.has(url), `unexpected synthetic resource: ${new URL(url).pathname}`);
    const bytes = Buffer.from(resources.get(url));
    options.onBytes(bytes.length);
    return { bytes, url };
  };
}

function fixtureRun(duration, onMux = async () => {}) {
  return async (_binary, args) => {
    assert.ok(!args.some(arg => /https?:|SECRET|key\.bin/.test(arg)), 'tools only receive local resource names');
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    if (args.includes('-show_streams')) return JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video' }] });
    await onMux(args);
    await writeFile(args.at(-1), 'synthetic-output');
    return '';
  };
}

test('AES parser supports explicit identity IV and exact implicit large sequence IVs', () => {
  const explicit = parsePlaylist(playlist(`${keyTag},KEYFORMAT="identity",KEYFORMATVERSIONS="1"\n${segment('one.ts')}\n${segment('two.ts')}`), base);
  assert.deepEqual(explicit.encryption.map(item => item.iv), [iv, iv]);
  assert.equal(explicit.encryption[0].key, explicit.encryption[1].key, 'one declaration is shared by its segments');
  assert.equal(explicit.encryption[0].key.uri, keyURL);
  const start = 9007199254740993n;
  const implicit = parsePlaylist(playlist(`#EXT-X-MEDIA-SEQUENCE:${start}\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n${segment('one.ts')}\n${segment('two.ts')}`), base);
  assert.deepEqual(implicit.encryption.map(item => item.iv), [start, start + 1n].map(value => value.toString(16).padStart(32, '0')));
  const short = parsePlaylist(playlist(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1\n${segment('one.ts')}`), base);
  assert.equal(short.encryption[0].iv, '00000000000000000000000000000001');
  const zero = parsePlaylist(playlist(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n${segment('one.ts')}`), base);
  assert.equal(zero.encryption[0].iv, '0'.repeat(32));
});

test('AES parser scopes key rotation, METHOD=NONE and initialization-map IV correctly', () => {
  const parsed = parsePlaylist(playlist(`${keyTag}\n#EXT-X-MAP:URI="init.mp4"\n${segment('one.ts')}\n${keyTag}\n${segment('two.ts')}\n#EXT-X-KEY:METHOD=NONE\n${segment('three.ts')}`), base);
  assert.equal(parsed.encryption.length, parsed.resources.length);
  assert.equal(parsed.encryption[0].key, parsed.encryption[1].key);
  assert.notEqual(parsed.encryption[1].key, parsed.encryption[2].key, 'a repeated URI may provide rotated material');
  assert.equal(parsed.encryption[3], null);
  assert.throws(() => parsePlaylist(playlist(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n${segment('one.ts')}`), base), /显式.*IV/);
});

test('AES parser rejects invalid methods, key attributes, IVs and non-public key URIs', () => {
  const invalid = [
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
    '#EXT-X-KEY:METHOD=AES-256,URI="key.bin"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="com.apple.streamingkeydelivery"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMATVERSIONS="2"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMATVERSIONS="1//2"',
    '#EXT-X-KEY:METHOD=AES-128',
    '#EXT-X-KEY:METHOD=AES-128,URI=""',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0xZZ',
    `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${'1'.repeat(33)}`,
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=1234',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",METHOD=NONE',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",',
    '#EXT-X-KEY:METHOD=AES-128,URI="unterminated',
    '#EXT-X-KEY:METHOD=NONE,URI="key.bin"',
    ...['http://127.0.0.1/key', 'http://169.254.169.254/key', 'http://localhost/key', 'file:///secret', 'https://user:pass@media.example/key'].map(uri => `#EXT-X-KEY:METHOD=AES-128,URI="${uri}"`),
  ];
  for (const tag of invalid) assert.throws(() => parsePlaylist(playlist(`${tag}\n${segment('one.ts')}`), base), VideoError, tag);
  for (const seq of ['-1', '1.5', '18446744073709551616', 'nope']) {
    assert.throws(() => parsePlaylist(playlist(`#EXT-X-MEDIA-SEQUENCE:${seq}\n${keyTag}\n${segment('one.ts')}`), base), /媒体序号/);
  }
  assert.throws(() => parsePlaylist(playlist(`#EXT-X-MEDIA-SEQUENCE:18446744073709551615\n${keyTag}\n${segment('one.ts')}\n${segment('two.ts')}`), base), /64 位/);
});

test('AES download decrypts before validation and writes only offline plaintext assets', async t => {
  const directory = await directoryFor(t);
  const text = playlist(`${keyTag}\n${segment('one.ts?token=SEGMENT_SECRET')}\n${segment('two.ts')}`);
  const cipher = encrypted(ts);
  const resources = new Map([[base, Buffer.from(text)], [keyURL, key], [urlFor('one.ts?token=SEGMENT_SECRET'), cipher], [urlFor('two.ts'), cipher]]);
  const seen = []; const exposedKeys = []; const fetcher = fixtureFetcher(resources, seen);
  const result = await downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: () => {},
    fetcher: async (url, options) => {
      const response = await fetcher(url, options);
      if (url === keyURL) exposedKeys.push(response.bytes);
      return response;
    },
    run: fixtureRun(4, async args => {
      const local = await readFile(args[args.indexOf('-i') + 1], 'utf8');
      assert.ok(!/EXT-X-KEY|https?:|SECRET|key\.bin/.test(local));
      assert.deepEqual(await readFile(path.join(directory, 'track-0-0.ts')), ts);
      assert.deepEqual(await readFile(path.join(directory, 'track-0-1.ts')), ts);
    }),
  });
  assert.equal(result.downloaded, 2);
  assert.equal(result.bytes, Buffer.byteLength(text) + 16 + cipher.length * 2, 'encrypted payload and key bytes count towards budget');
  assert.deepEqual(seen.filter(item => item.url === keyURL).map(item => item.maxBytes), [16]);
  assert.deepEqual(await readdir(directory), ['output.partial.mp4', 'track-0-0.ts', 'track-0-1.ts', 'track-0.m3u8']);
  assert.ok(exposedKeys.every(bytes => bytes.every(byte => byte === 0)), 'in-memory fetched keys are cleared after use');
});

test('AES download uses implicit per-segment sequence IV, supports same-URI rotation and NONE', async t => {
  const directory = await directoryFor(t);
  const start = 9007199254740993n;
  const implicitTag = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=KEY_SECRET"';
  const text = playlist(`#EXT-X-MEDIA-SEQUENCE:${start}\n${implicitTag}\n${segment('one.ts')}\n${segment('two.ts')}\n${implicitTag}\n${segment('three.ts')}\n#EXT-X-KEY:METHOD=NONE\n${segment('four.ts')}`);
  const vector = index => (start + BigInt(index)).toString(16).padStart(32, '0');
  const resources = new Map([[base, Buffer.from(text)], [urlFor('one.ts'), encrypted(ts, key, vector(0))], [urlFor('two.ts'), encrypted(ts, key, vector(1))], [urlFor('three.ts'), encrypted(ts, otherKey, vector(2))], [urlFor('four.ts'), ts]]);
  let keyRequests = 0;
  const fetcher = fixtureFetcher(resources);
  await downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: () => {},
    fetcher: async (url, options) => {
      if (url !== keyURL) return fetcher(url, options);
      const bytes = Buffer.from(keyRequests++ === 0 ? key : otherKey);
      options.onBytes(bytes.length); return { bytes, url };
    },
    run: fixtureRun(8),
  });
  assert.equal(keyRequests, 2);
  for (let i = 0; i < 4; i++) assert.deepEqual(await readFile(path.join(directory, `track-0-${i}.ts`)), ts);
});

test('AES download decrypts an explicitly-IV encrypted initialization map', async t => {
  const directory = await directoryFor(t);
  const text = playlist(`${keyTag}\n#EXT-X-MAP:URI="init.mp4"\n${segment('one.ts')}`);
  const resources = new Map([[base, Buffer.from(text)], [keyURL, key], [urlFor('init.mp4'), encrypted(mapBytes)], [urlFor('one.ts'), encrypted(ts)]]);
  await downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: () => {}, fetcher: fixtureFetcher(resources),
    run: fixtureRun(2, async args => {
      const local = await readFile(args[args.indexOf('-i') + 1], 'utf8');
      assert.match(local, /#EXT-X-MAP:URI="track-0-0.mp4"/);
      assert.deepEqual(await readFile(path.join(directory, 'track-0-0.mp4')), mapBytes);
    }),
  });
});

test('master SESSION-KEY is a hint and does not decrypt or fetch keys for clear child playlists', async t => {
  const directory = await directoryFor(t);
  const master = `#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="unused.key"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nclear.m3u8\n`;
  const resources = new Map([[base, Buffer.from(master)], [urlFor('clear.m3u8'), Buffer.from(playlist(segment('clear.ts')))], [urlFor('clear.ts'), ts]]);
  const seen = [];
  await downloadVideo(base, directory, { signal: new AbortController().signal, progress: () => {}, fetcher: fixtureFetcher(resources, seen), run: fixtureRun(2) });
  assert.equal(seen.length, 3);
  assert.ok(!seen.some(item => item.url.endsWith('.key')));
  assert.throws(() => parsePlaylist(master.replace('METHOD=AES-128', 'METHOD=NONE'), base), /NONE/);
  assert.throws(() => parsePlaylist(master.replace('METHOD=AES-128', 'METHOD=SAMPLE-AES'), base), /SAMPLE-AES/);
});

test('AES failures reject bad key lengths, ciphertext length, padding and decrypted non-media', async t => {
  const directory = await directoryFor(t);
  const text = playlist(`${keyTag}\n${segment('one.ts')}`);
  const validCipher = encrypted(ts);
  const badPadding = Buffer.from(validCipher);
  // Last padding octet is 8. Flipping its preceding CBC block byte makes it 0.
  badPadding[badPadding.length - 17] ^= 8;
  const variants = [
    { material: Buffer.alloc(0), cipher: validCipher, match: /16 字节/ },
    { material: Buffer.alloc(15), cipher: validCipher, match: /16 字节/ },
    { material: Buffer.alloc(17), cipher: validCipher, match: /16 字节/ },
    { material: otherKey, cipher: validCipher, match: /解密失败|分片不是/ },
    { material: key, cipher: validCipher.subarray(0, validCipher.length - 1), match: /长度无效/ },
    { material: key, cipher: badPadding, match: /解密失败/ },
    { material: key, cipher: encrypted(Buffer.from('<html>not media</html>')), match: /分片不是/ },
  ];
  for (const variant of variants) {
    const resources = new Map([[base, Buffer.from(text)], [keyURL, variant.material], [urlFor('one.ts'), variant.cipher]]);
    const seen = []; let toolCalls = 0;
    await assert.rejects(downloadVideo(base, directory, {
      signal: new AbortController().signal, progress: () => {}, fetcher: fixtureFetcher(resources, seen),
      run: async () => { toolCalls++; throw new Error('should never call tool'); },
    }), error => variant.match.test(error.message) && !/SECRET|key\.bin/.test(error.message));
    assert.equal(toolCalls, 0);
    assert.deepEqual(await readdir(directory), []);
    if (variant.material.length !== 16) assert.equal(seen.length, 2, 'bad keys fail before segment requests');
  }
});

test('key fetching preserves public-DNS checks, bounds key requests and rejects private redirects', async t => {
  const directory = await directoryFor(t);
  const source = 'http://fixture.example/list.m3u8';
  const text = playlist('#EXT-X-KEY:METHOD=AES-128,URI="http://key.example/key.bin"\n' + segment('one.ts'));
  const requested = []; let redirectKey = false;
  t.mock.method(http, 'get', (url, _config, callback) => {
    requested.push(url.hostname);
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
    queueMicrotask(() => {
      const response = Readable.from([Buffer.from(url.hostname === 'fixture.example' ? text : '')]);
      response.statusCode = url.hostname === 'fixture.example' ? 200 : 302;
      response.headers = response.statusCode === 302 ? { location: 'http://127.0.0.1/secret' } : {};
      callback(response);
    });
    return request;
  });
  const fetcher = (url, options) => fetchResource(url, {
    ...options,
    resolver: async hostname => [{ address: hostname === 'key.example' && !redirectKey ? '127.0.0.1' : '8.8.8.8' }],
  });
  const options = { signal: new AbortController().signal, progress: () => {}, fetcher, run: fixtureRun(2) };
  await assert.rejects(downloadVideo(source, directory, options), /密钥失败.*非公网/);
  assert.deepEqual(requested, ['fixture.example']);
  redirectKey = true;
  await assert.rejects(downloadVideo(source, directory, options), /密钥失败.*公网/);
  assert.deepEqual(requested, ['fixture.example', 'fixture.example', 'key.example']);
});

test('key bytes consume quota and aborts prevent segment fetches while wiping cached keys', async t => {
  const directory = await directoryFor(t);
  const text = playlist(`${keyTag}\n${segment('one.ts')}`);
  const resources = new Map([[base, Buffer.from(text)], [keyURL, key], [urlFor('one.ts'), encrypted(ts)]]);
  const quotaSeen = [];
  await assert.rejects(downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: () => {}, fetcher: fixtureFetcher(resources, quotaSeen),
    budget: { bytes: LIMITS.bytes - Buffer.byteLength(text) - 15 }, run: fixtureRun(2),
  }), /1 GiB/);
  assert.equal(quotaSeen.length, 2, 'key bytes exhaust quota before downloading the segment');
  const controller = new AbortController(); const seen = []; const fetcher = fixtureFetcher(resources, seen); let fetchedKey;
  await assert.rejects(downloadVideo(base, directory, {
    signal: controller.signal, progress: () => {},
    fetcher: async (url, options) => {
      const response = await fetcher(url, options);
      if (url === keyURL) { fetchedKey = response.bytes; controller.abort(); }
      return response;
    },
    run: fixtureRun(2),
  }));
  assert.equal(seen.length, 2);
  assert.ok(fetchedKey.every(byte => byte === 0));
  assert.deepEqual(await readdir(directory), []);
});

test('key HTTP authorization failures return contextual safe errors without retries', async t => {
  const directory = await directoryFor(t);
  const text = playlist(`${keyTag}\n${segment('one.ts')}`);
  let keyRequests = 0;
  await assert.rejects(downloadVideo(base, directory, {
    signal: new AbortController().signal, progress: () => {},
    fetcher: async (url, options) => {
      if (url === keyURL) { keyRequests++; throw new VideoError('来源拒绝访问（HTTP 403）。'); }
      assert.equal(url, base); const bytes = Buffer.from(text); options.onBytes(bytes.length); return { bytes, url };
    },
    run: fixtureRun(2),
  }), error => /密钥失败.*HTTP 403/.test(error.message) && !/SECRET|key\.bin/.test(error.message));
  assert.equal(keyRequests, 1);
});
