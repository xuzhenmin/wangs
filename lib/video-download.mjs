// Network boundary: FFmpeg only sees locally rewritten playlists, never remote URLs.
import https from 'node:https';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { writeFile, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

export const LIMITS = { bytes: 1024 ** 3, segment: 32 * 1024 ** 2, playlist: 1024 ** 2, files: 10000, duration: 7200, timeout: 30 * 60 * 1000 };
function toolPath(name) {
  const configured = process.env[name === 'ffmpeg' ? 'VIDEO_FFMPEG_PATH' : 'VIDEO_FFPROBE_PATH'];
  if (configured) return configured;
  // macOS launchd does not necessarily inherit Homebrew's shell PATH.
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(directory => path.join(directory, name)).find(file => existsSync(/* turbopackIgnore: true */ file)) || name;
}
export class VideoError extends Error {}
export function requestFailure(error) {
  if (error instanceof VideoError) return error;
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
  if (code === 'ABORT_ERR') return new VideoError('请求已取消或达到任务时限（ABORT_ERR）。');
  if (code === 'ERR_INVALID_IP_ADDRESS') return new VideoError('网络地址解析结果格式不兼容（ERR_INVALID_IP_ADDRESS）。');
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return new VideoError(`HTTPS 安全连接或证书验证失败（${code}），未跳过验证。`);
  // Expose only a bounded error code, never Node's raw message containing signed URLs.
  return new VideoError(`网络连接失败（${code}）。请检查来源服务器是否可访问。`);
}
export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
export function sourceURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new VideoError('视频地址格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.href.length > 8192 || (url.port && !['80', '443'].includes(url.port)) ||
      url.hostname.endsWith('.local') || url.hostname === 'localhost' ||
      (isIP(url.hostname.replace(/[\[\]]/g, '')) && !publicIPv4(url.hostname))) {
    throw new VideoError('仅支持公网 HTTP/HTTPS 标准端口资源，禁止内网和本地地址。');
  }
  url.hash = '';
  return url;
}

// Resolve once per request, reject mixed/private answers, pin the chosen IP at connect time.
export async function fetchResource(value, { signal, maxBytes, onBytes = () => {}, resolver = lookup }, redirects = 0) {
  signal.throwIfAborted();
  const url = sourceURL(value);
  let addresses;
  try { addresses = await resolver(url.hostname, { all: true, family: 4 }); }
  catch { throw new VideoError('资源域名解析失败。'); }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new VideoError('资源解析到非公网地址，已阻止请求。');
  const pinned = addresses[0].address;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent: false, family: 4,
      lookup: (_hostname, options, callback) => {
        // Node 20+ autoSelectFamily can request all:true. Respect both lookup contracts
        // while returning only the previously validated, pinned IPv4 address.
        if (options.all) callback(null, [{ address: pinned, family: 4 }]);
        else callback(null, pinned, 4);
      },
      headers: { 'User-Agent': 'Shenxiang-Video-Import/1.0', 'Accept-Encoding': 'identity' },
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (redirects >= 4 || !response.headers.location) return reject(new VideoError('资源重定向过多或无效。'));
        let next;
        try { next = sourceURL(response.headers.location, url).href; } catch (error) { return reject(error); }
        resolve(fetchResource(next, { signal, maxBytes, onBytes, resolver }, redirects + 1));
        return;
      }
      if (status !== 200) {
        response.destroy();
        reject(new VideoError([401, 403].includes(status)
          ? `HTTP ${status}：访问被拒绝，可能授权失效或签名过期。请在原页面正常刷新后重新提交。`
          : `资源请求失败（HTTP ${status}）。`));
        return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy(); reject(new VideoError('资源超过单文件大小限制。')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        try {
          size += chunk.length;
          if (size > maxBytes) throw new VideoError('资源超过单文件大小限制。');
          onBytes(chunk.length); chunks.push(chunk);
        } catch (error) { response.destroy(); reject(error); }
      });
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks), url: url.href }));
      response.on('aborted', () => reject(new VideoError('资源传输中断，请重试。')));
      response.on('error', () => reject(new VideoError('资源传输中断，请重试。')));
    });
    request.setTimeout(20000, () => request.destroy(new VideoError('资源请求超时。')));
    request.on('error', error => reject(requestFailure(error)));
  });
}

export function segmentExtension(bytes) {
  if (bytes.length >= 188 && bytes[0] === 0x47 && (bytes.length < 376 || bytes[188] === 0x47)) return 'ts';
  if (bytes.length >= 8 && ['ftyp', 'styp', 'moof', 'sidx'].includes(bytes.toString('ascii', 4, 8))) return 'mp4';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac';
  // Fail closed: never feed an HTML error, disguised nested playlist or arbitrary text to FFmpeg.
  throw new VideoError('分片不是首版支持的 TS / fMP4 / ADTS 音频格式。');
}

function attributes(line, strict = false) {
  const result = {};
  const text = line.slice(line.indexOf(':') + 1);
  if (strict) {
    const pattern = /([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\s"]+))(?:,|$)/y;
    let offset = 0;
    while (offset < text.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(text);
      if (!match || Object.hasOwn(result, match[1])) throw new VideoError('HLS 密钥属性格式无效或重复。');
      result[match[1]] = match[2] ?? match[3];
      offset = pattern.lastIndex;
    }
    if (!offset || text.endsWith(',')) throw new VideoError('HLS 密钥属性格式无效。');
    return result;
  }
  for (const match of text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g)) result[match[1]] = match[2] ?? match[3];
  return result;
}

function encryptionKey(line, base) {
  const attrs = attributes(line, true);
  if (attrs.METHOD === 'NONE') {
    if (line.startsWith('#EXT-X-SESSION-KEY:') || Object.keys(attrs).length !== 1) throw new VideoError('METHOD=NONE 密钥声明无效。');
    return null;
  }
  if (attrs.METHOD !== 'AES-128' || (attrs.KEYFORMAT !== undefined && attrs.KEYFORMAT !== 'identity')) {
    throw new VideoError('仅支持标准 AES-128（identity）加密，不支持 SAMPLE-AES 或 DRM。');
  }
  const versions = attrs.KEYFORMATVERSIONS ?? '1';
  if (!/^[1-9]\d*(?:\/[1-9]\d*)*$/.test(versions) || !versions.split('/').includes('1')) throw new VideoError('不支持此 HLS 密钥格式版本。');
  if (!attrs.URI) throw new VideoError('AES-128 清单缺少密钥 URI。');
  if (attrs.IV !== undefined && !/^0[xX][0-9a-fA-F]{1,32}$/.test(attrs.IV)) throw new VideoError('AES-128 IV 必须是最多 128 位的十六进制数。');
  return { uri: sourceURL(attrs.URI, base).href, iv: attrs.IV?.slice(2).toLowerCase().padStart(32, '0') };
}

export function parsePlaylist(text, base) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new VideoError('响应不是有效的 HLS 播放清单。');
  // Session keys are only preloading hints. Media EXT-X-KEY tags still determine
  // which key/IV applies; never assume a master key encrypts every rendition.
  for (const line of lines) if (line.startsWith('#EXT-X-SESSION-KEY:')) encryptionKey(line, base);
  if (lines.some(line => /^#EXT-X-(BYTERANGE|PART|PRELOAD-HINT|SKIP|DEFINE|SESSION-DATA|CONTENT-STEERING|I-FRAMES-ONLY)/.test(line))) {
    throw new VideoError('暂不支持字节范围、低延迟或动态变量播放清单。');
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = attributes(lines[i]);
      if (!lines[i + 1] || lines[i + 1].startsWith('#')) throw new VideoError('多码率清单结构无效。');
      variants.push({ url: sourceURL(lines[i + 1], base).href, bandwidth: Number(attrs.BANDWIDTH) || 0, audio: attrs.AUDIO });
    }
  }
  if (variants.length) {
    if (lines.some(line => line.startsWith('#EXT-X-KEY:'))) throw new VideoError('主清单不能包含媒体分片密钥标签。');
    const variant = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    let audio;
    if (variant.audio) {
      const tracks = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(line => attributes(line))
        .filter(attrs => attrs.TYPE === 'AUDIO' && attrs['GROUP-ID'] === variant.audio);
      if (!tracks.length) throw new VideoError('播放清单缺少音轨配置。');
      const track = tracks.find(attrs => attrs.DEFAULT === 'YES') || tracks[0];
      if (track.URI) audio = sourceURL(track.URI, base).href;
    }
    return { kind: 'master', url: variant.url, audio };
  }
  if (!lines.includes('#EXT-X-ENDLIST')) throw new VideoError('只支持完整点播清单，不支持直播或尚未结束的视频。');
  let duration = 0, count = 0, waiting = false;
  let activeKey = null, sequence = 0n, hasSequence = false;
  const maxSequence = (1n << 64n) - 1n;
  const resources = []; const output = []; const encryption = [];
  const allowed = /^#(?:EXTM3U$|EXTINF:|EXT-X-(?:VERSION:|TARGETDURATION:|MEDIA-SEQUENCE:|DISCONTINUITY-SEQUENCE:|PLAYLIST-TYPE:|DISCONTINUITY$|ENDLIST$|INDEPENDENT-SEGMENTS$|PROGRAM-DATE-TIME:|START:))/;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) { activeKey = encryptionKey(line, base); continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice('#EXT-X-MEDIA-SEQUENCE:'.length);
      if (hasSequence || count || !/^\d{1,20}$/.test(value) || BigInt(value) > maxSequence) throw new VideoError('HLS 媒体序号无效、重复或位置错误。');
      sequence = BigInt(value); hasSequence = true;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line);
      if (!attrs.URI || attrs.BYTERANGE) throw new VideoError('暂不支持此初始化分片结构。');
      if (activeKey && !activeKey.iv) throw new VideoError('AES-128 加密初始化分片必须显式指定 IV。');
      const index = resources.push(sourceURL(attrs.URI, base).href) - 1;
      encryption.push(activeKey ? { key: activeKey, iv: activeKey.iv } : null);
      output.push({ map: index }); continue;
    }
    if (!line.startsWith('#')) {
      if (!waiting) throw new VideoError('分片缺少时长标记。');
      const mediaSequence = sequence + BigInt(count);
      if (mediaSequence > maxSequence) throw new VideoError('HLS 媒体序号超过 64 位范围。');
      const index = resources.push(sourceURL(line, base).href) - 1;
      encryption.push(activeKey ? { key: activeKey, iv: activeKey.iv ?? mediaSequence.toString(16).padStart(32, '0') } : null);
      output.push({ segment: index }); count++; waiting = false; continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const seconds = Number(line.slice(8).split(',')[0]);
      if (waiting || !Number.isFinite(seconds) || seconds <= 0) throw new VideoError('分片时长无效。');
      duration += seconds; waiting = true;
    }
    if (line.startsWith('#EXT') && !allowed.test(line)) throw new VideoError('播放清单含首版不支持的标签。');
    if (allowed.test(line)) output.push(line);
  }
  if (!count || waiting || duration > LIMITS.duration || resources.length > LIMITS.files) throw new VideoError('清单不完整，或超过 2 小时 / 10000 个分片限制。');
  return { kind: 'media', output, resources, encryption, duration };
}

function decryptFragment(bytes, key, iv) {
  if (!bytes.length || bytes.length % 16 !== 0) throw new VideoError('AES-128 分片长度无效，可能下载不完整。');
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.from(iv, 'hex'));
    // HLS AES-128 uses PKCS#7 padding independently for each segment.
    return Buffer.concat([decipher.update(bytes), decipher.final()]);
  } catch {
    throw new VideoError('AES-128 分片解密失败：密钥或 IV 不匹配，或分片已损坏。请刷新来源页面后重新提交。');
  }
}

export function command(binary, args, signal, onStdout = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', timer;
    const onExit = () => child.kill('SIGKILL');
    process.once('exit', onExit);
    const abort = () => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 1500); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', value => { stdout = (stdout + value).slice(-1024 * 1024); onStdout(String(value)); });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-8192); });
    const cleanup = () => { clearTimeout(timer); process.removeListener('exit', onExit); signal?.removeEventListener('abort', abort); };
    child.on('error', () => { cleanup(); reject(new VideoError('未找到或无法启动 FFmpeg / ffprobe，请按管理页说明手动安装并重启服务。')); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) reject(new VideoError('任务已取消或超过 30 分钟时限。'));
      else if (code !== 0) reject(new VideoError(`媒体处理失败（退出码 ${code}）；可能编码不兼容或分片损坏。${/No space left/i.test(stderr) ? '磁盘空间不足。' : ''}`));
      else resolve(stdout);
    });
  });
}

export async function checkTools() {
  const signal = AbortSignal.timeout(5000);
  await command(toolPath('ffmpeg'), ['-version'], signal);
  await command(toolPath('ffprobe'), ['-version'], signal);
}

export async function downloadVideo(url, directory, { signal, progress, fetcher = fetchResource, run = command, budget = { bytes: 0 } }) {
  let bytes = 0, downloaded = 0, total = 0, counter = 0;
  const onBytes = size => { budget.bytes += size; bytes = budget.bytes; if (bytes > LIMITS.bytes) throw new VideoError('任务下载量超过 1 GiB。'); };
  async function fetchChecked(value, maxBytes) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await fetcher(value, { signal, maxBytes, onBytes }); }
      catch (error) {
        if (signal.aborted || attempt >= 2 || !(error instanceof VideoError) || !/网络连接|传输中断|请求超时|HTTP 50[234]/.test(error.message)) throw error;
      }
    }
  }
  async function manifest(value, depth = 0) {
    if (depth > 4) throw new VideoError('播放清单嵌套层级过深。');
    const response = await fetchChecked(value, LIMITS.playlist);
    const playlist = parsePlaylist(response.bytes.toString('utf8'), response.url);
    if (playlist.kind === 'master') {
      const video = await manifest(playlist.url, depth + 1);
      if (playlist.audio) {
        const audio = await manifest(playlist.audio, depth + 1);
        if (audio.audio) throw new VideoError('音轨清单结构不支持。');
        video.audio = audio.file;
      }
      return video;
    }
    const prefix = `track-${counter++}`;
    const filenames = [];
    total += playlist.resources.length;
    if (total > LIMITS.files) throw new VideoError('任务分片数超过限制。');
    const keys = new Map();
    try {
      for (let i = 0; i < playlist.resources.length; i++) {
        signal.throwIfAborted();
        const space = await statfs(directory);
        if (space.bavail * space.bsize < 2 * LIMITS.bytes) throw new VideoError('可用磁盘不足 2 GiB，已停止下载。');
        const encrypted = playlist.encryption[i];
        if (encrypted && !keys.has(encrypted.key)) {
          let response;
          try { response = await fetchChecked(encrypted.key.uri, 16); }
          catch (error) {
            if (signal.aborted) throw error;
            throw new VideoError(`获取 AES-128 密钥失败：${error instanceof VideoError ? error.message : '网络请求异常。'}`);
          }
          if (response.bytes.length !== 16) {
            response.bytes.fill(0);
            throw new VideoError('AES-128 密钥必须是 16 字节二进制数据，来源可能返回了错误页面。');
          }
          // Cache by declaration, not URI: a later declaration can rotate key
          // material even when its URI is unchanged. Keys never go to disk.
          keys.set(encrypted.key, response.bytes);
        }
        signal.throwIfAborted();
        const fragment = await fetchChecked(playlist.resources[i], LIMITS.segment);
        signal.throwIfAborted();
        const content = encrypted ? decryptFragment(fragment.bytes, keys.get(encrypted.key), encrypted.iv) : fragment.bytes;
        if (!content.length) throw new VideoError('视频分片为空。');
        const filename = `${prefix}-${i}.${segmentExtension(content)}`;
        filenames.push(filename);
        await writeFile(path.join(directory, filename), content, { mode: 0o600 });
        downloaded++;
        progress({ status: 'downloading', downloaded, total, bytes });
      }
    } finally {
      for (const key of keys.values()) key.fill(0);
      keys.clear();
    }
    const rewritten = playlist.output.map(line => typeof line === 'string' ? line : 'map' in line
      ? `#EXT-X-MAP:URI="${filenames[line.map]}"` : filenames[line.segment]).join('\n');
    const file = path.join(directory, `${prefix}.m3u8`);
    await writeFile(file, rewritten + '\n', { mode: 0o600 });
    return { file, duration: playlist.duration };
  }
  const source = await manifest(url);
  signal.throwIfAborted(); progress({ status: 'muxing' });
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-protocol_whitelist', 'file', '-format_whitelist', 'hls,mpegts,mov,aac', '-i', source.file];
  if (source.audio) args.push('-protocol_whitelist', 'file', '-format_whitelist', 'hls,mpegts,mov,aac', '-i', source.audio);
  args.push('-map', '0:v:0', '-map', source.audio ? '1:a:0' : '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-fs', String(LIMITS.bytes), path.join(directory, 'output.partial.mp4'));
  await run(toolPath('ffmpeg'), args, signal);
  progress({ status: 'verifying' });
  const metadata = JSON.parse(await run(toolPath('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', path.join(directory, 'output.partial.mp4')], signal));
  const duration = Number(metadata.format?.duration);
  if (!metadata.streams?.some(stream => stream.codec_type === 'video') || (source.audio && !metadata.streams.some(stream => stream.codec_type === 'audio')) ||
      !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - source.duration) > Math.max(3, source.duration * 0.02)) {
    throw new VideoError('输出轨道或时长校验失败，文件可能不完整。');
  }
  return { duration, bytes, downloaded, total };
}
