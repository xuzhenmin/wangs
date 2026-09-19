import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS, VideoError } from '../lib/video-download.mjs';

function toolPath(name) {
  return process.env[name === 'ffmpeg' ? 'VIDEO_FFMPEG_PATH' : 'VIDEO_FFPROBE_PATH'] ||
    ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(directory => path.join(directory, name)).find(file => existsSync(/* turbopackIgnore: true */ file)) || name;
}

// The subprocess sees local files only. Never include its raw stderr (paths/media metadata) in public errors.
async function run(command, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
    let output = '', size = 0;
    const collect = (chunk, stdout) => {
      size += chunk.length;
      if (size > LIMITS.playlist) { child.kill('SIGKILL'); return; }
      if (stdout) output += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.on('error', () => reject(new VideoError('私密视频打包工具不可用或任务已取消，请检查 FFmpeg / ffprobe 配置。')));
    child.on('close', code => code === 0 && size <= LIMITS.playlist
      ? resolve(output)
      : reject(new VideoError('私密视频加密打包失败或达到处理时限；原视频仍然保留。')));
  });
}

async function checkOutput(directory) {
  const names = await readdir(directory);
  if (names.length > LIMITS.files + 3) throw new VideoError('私密视频分片数量超过限制。');
  let total = 0;
  for (const name of names) {
    const info = await lstat(path.join(directory, name)).catch(error => {
      // FFmpeg atomically renames the finished playlist while the watchdog is reading.
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new VideoError('私密视频打包生成了无效文件。');
    total += info.size;
    if (total > LIMITS.bytes || (/\.ts$/.test(name) && info.size > LIMITS.segment)) throw new VideoError('加密分片超过 1 GiB 总量或 32 MiB 单片限制，请先压缩原视频。');
  }
}

/** Creates AES-128 HLS in a private temporary directory; caller must invoke cleanup in finally. */
export async function packagePrivateVideo(file, options = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? LIMITS.timeout);
  let directory, watchdog, checking = false, checkTask, failure;
  const key = randomBytes(16), iv = randomBytes(16);
  const cleanup = async () => {
    clearTimeout(timeout); clearInterval(watchdog);
    if (checkTask) await checkTask;
    key.fill(0); iv.fill(0);
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  try {
    signal.throwIfAborted();
    const info = await lstat(file);
    if (!path.isAbsolute(file) || !info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size >= LIMITS.bytes) throw new VideoError('私密视频原文件无效或超过 1 GiB。');
    const execute = options.run || run;
    let metadata;
    try { metadata = JSON.parse(await execute(toolPath('ffprobe'), ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file], signal)); }
    catch (error) { if (error instanceof VideoError) throw error; throw new VideoError('无法读取视频编码信息。'); }
    const videos = metadata.streams?.filter(stream => stream.codec_type === 'video') || [];
    const audios = metadata.streams?.filter(stream => stream.codec_type === 'audio') || [];
    if (videos[0]?.codec_name !== 'h264' || (audios.length && audios[0]?.codec_name !== 'aac')) throw new VideoError('私密视频目前仅支持 H.264 视频和 AAC 音频（或无音轨）。请先转换编码后重新导入；不会自动转码或公开上传。');
    const duration = Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > LIMITS.duration) throw new VideoError('视频时长无效或超过 2 小时。');
    directory = await mkdtemp(path.join(tmpdir(), 'shenxiang-private-video-'));
    await chmod(directory, 0o700);
    const disk = await statfs(directory);
    if (Number(disk.bavail) * Number(disk.bsize) < Math.min(LIMITS.bytes, info.size * 1.3) + 64 * 1024 ** 2) throw new VideoError('临时目录可用空间不足，无法安全加密视频。');
    const keyPath = path.join(directory, 'key.bin'), keyInfo = path.join(directory, 'key-info.txt');
    await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
    await writeFile(keyInfo, `key.bin\n${keyPath}\n${iv.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    watchdog = setInterval(() => {
      if (checking) return;
      checking = true;
      checkTask = checkOutput(directory).catch(error => { failure = error; controller.abort(); }).finally(() => { checking = false; });
    }, 1000);
    try {
      await execute(toolPath('ffmpeg'), [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file', '-i', file,
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-threads', '2', '-c', 'copy',
        '-f', 'hls', '-hls_segment_type', 'mpegts', '-hls_time', '6', '-hls_playlist_type', 'vod', '-start_number', '0',
        '-hls_key_info_file', keyInfo, '-hls_segment_filename', path.join(directory, 'segment-%05d.ts'), path.join(directory, 'index.m3u8'),
      ], signal);
    } catch (error) { throw failure || error; }
    clearInterval(watchdog);
    if (checkTask) await checkTask;
    if (failure) throw failure;
    signal.throwIfAborted();
    await checkOutput(directory);
    const manifest = await readFile(path.join(directory, 'index.m3u8'), 'utf8');
    if (Buffer.byteLength(manifest) > LIMITS.playlist || !manifest.includes('#EXT-X-ENDLIST') ||
        !manifest.includes(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}`)) throw new VideoError('加密播放清单格式不正确，已停止上传。');
    const names = manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (!names.length || names.length > LIMITS.files) throw new VideoError('私密视频分片数量无效。');
    const segments = [];
    for (const [index, name] of names.entries()) {
      if (name !== `segment-${String(index).padStart(5, '0')}.ts`) throw new VideoError('加密分片名称无效。');
      const segmentFile = path.join(directory, name), segmentInfo = await lstat(segmentFile);
      if (segmentInfo.size <= 0 || segmentInfo.size % 16 || segmentInfo.size > LIMITS.segment) throw new VideoError('加密分片大小无效。');
      await chmod(segmentFile, 0o600);
      segments.push({ name, file: segmentFile, bytes: segmentInfo.size });
    }
    await unlink(keyPath); await unlink(keyInfo);
    clearTimeout(timeout);
    return { directory, key, manifest, segments, duration, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof VideoError) throw error;
    throw new VideoError('私密视频加密打包失败或任务已取消，原视频仍然保留。');
  }
}
