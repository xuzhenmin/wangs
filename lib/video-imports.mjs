import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkTools, downloadVideo, sourceURL, VideoError, LIMITS } from './video-download.mjs';

const KEY = Symbol.for('shenxiang.video-imports.v1');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTIVE = new Set(['queued', 'checking', 'downloading', 'muxing', 'verifying']);
export const videoRoot = () => process.env.VIDEO_IMPORT_DIR ? path.resolve(process.env.VIDEO_IMPORT_DIR) : path.join(process.cwd(), 'data', 'video-imports');
const digest = value => createHash('sha256').update(value).digest('hex');

function save(job) {
  const directory = path.join(videoRoot(), job.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, 'result.json.tmp');
  writeFileSync(temp, JSON.stringify(job), { mode: 0o600 });
  renameSync(temp, path.join(directory, 'result.json'));
}
function state() {
  if (globalThis[KEY]) return globalThis[KEY];
  mkdirSync(videoRoot(), { recursive: true, mode: 0o700 });
  // A long-running Node process owns the queue. Refuse a second process sharing this directory.
  const lock = path.join(videoRoot(), 'process.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new VideoError('视频任务锁无效，请管理员检查 data/video-imports/process.lock。');
    if (pid !== process.pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new VideoError('视频任务目录正由另一服务进程使用；请使用单进程部署。');
      unlinkSync(lock);
    }
  }
  if (!existsSync(lock)) writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const value = { jobs: new Map(), queue: [], pairs: new Map(), running: false, health: null, healthAt: 0 };
  for (const name of readdirSync(videoRoot())) {
    if (!ID.test(name)) continue;
    try {
      const job = JSON.parse(readFileSync(path.join(videoRoot(), name, 'result.json'), 'utf8'));
      if (job.id !== name) continue;
      if (ACTIVE.has(job.status)) {
        job.status = 'failed'; job.error = '服务重启中断了任务，请在原页面重新提交（首版不支持断点续传）。';
        job.finishedAt = Date.now(); save(job);
      }
      if (job.publication?.status === 'uploading') {
        job.publication = { status: 'failed', progress: 0, error: '服务重启中断了 OSS 上传；本地视频仍然保留，请重新上传。' };
        save(job);
      }
      value.jobs.set(name, job);
    } catch { /* Ignore incomplete metadata, never treat it as a downloadable file. */ }
  }
  globalThis[KEY] = value;
  return value;
}

export async function toolsStatus() {
  const s = state();
  if (Date.now() - s.healthAt < 60000 && s.health) return s.health;
  if (s.healthPending) return s.healthPending;
  s.healthPending = (async () => {
    try { await checkTools(); s.health = { ready: true, message: '' }; }
    catch (error) { s.health = { ready: false, message: error instanceof VideoError ? error.message : '媒体工具暂时不可用。' }; }
    s.healthAt = Date.now();
    return s.health;
  })();
  try { return await s.healthPending; } finally { s.healthPending = null; }
}
export function createPairing() {
  const s = state();
  for (const [key, expires] of s.pairs) if (expires <= Date.now()) s.pairs.delete(key);
  if (s.pairs.size >= 10) throw new VideoError('配对码过多，请等待旧配对码过期。');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 10 * 60 * 1000;
  s.pairs.set(digest(token), expiresAt);
  return { token, expiresAt };
}
export function validPairing(token) {
  return typeof token === 'string' && token.length < 100 && (state().pairs.get(digest(token)) || 0) > Date.now();
}
export function consumePairing(token) { state().pairs.delete(digest(token)); }

export function validateBatch(input) {
  if (!input || input.authorized !== true) throw new VideoError('请先确认你有权保存所选视频。');
  if (!Array.isArray(input.videos) || !input.videos.length || input.videos.length > 6) throw new VideoError('每批请选择 1–6 个视频。');
  return input.videos.map((item, i) => {
    if (!item || typeof item.url !== 'string') throw new VideoError('视频地址缺失。');
    const url = sourceURL(item.url);
    if (item.backupUrl !== undefined && typeof item.backupUrl !== 'string') throw new VideoError('备用地址格式错误。');
    return {
      title: typeof item.title === 'string' ? item.title.slice(0, 120).replace(/[\x00-\x1f]/g, '') : `视频 ${i + 1}`,
      url: url.href, backupUrl: item.backupUrl ? sourceURL(item.backupUrl).href : undefined,
      sourceHost: url.hostname,
    };
  });
}
export function listVideoJobs() {
  return [...state().jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}
export function getVideoJob(id) { return ID.test(id) ? state().jobs.get(id) || null : null; }
export function setVideoPublication(id, publication) {
  const job = getVideoJob(id);
  if (!job || job.status !== 'completed') throw new VideoError('只有已完成的视频可以上传 OSS。');
  const previous = job.publication;
  job.publication = publication;
  try { save(job); } catch (error) { job.publication = previous; throw error; }
  return job;
}
export function videoFile(id) {
  const job = getVideoJob(id);
  return job?.status === 'completed' ? path.join(videoRoot(), id, 'video.mp4') : null;
}
export async function createVideoJobs(videos) {
  const s = state();
  if ([...s.jobs.values()].filter(job => ACTIVE.has(job.status)).length + videos.length > 12) throw new VideoError('队列最多容纳 12 个未完成任务。');
  const health = await toolsStatus();
  if (!health.ready) throw new VideoError(health.message);
  // Re-check after the asynchronous tool probe.
  if ([...s.jobs.values()].filter(job => ACTIVE.has(job.status)).length + videos.length > 12) throw new VideoError('队列已满，请稍后再提交。');
  const entries = videos.map(video => {
    const job = { id: randomUUID(), title: video.title, sourceHost: video.sourceHost, status: 'queued', createdAt: Date.now(), downloaded: 0, total: 0, bytes: 0, error: '' };
    return { job, url: video.url, backupUrl: video.backupUrl, controller: new AbortController() };
  });
  try { for (const entry of entries) save(entry.job); }
  catch (error) {
    await Promise.all(entries.map(entry => rm(path.join(videoRoot(), entry.job.id), { recursive: true, force: true }).catch(() => {})));
    throw error;
  }
  const jobs = entries.map(entry => entry.job);
  for (const job of jobs) s.jobs.set(job.id, job);
  s.queue.push(...entries);
  void drain();
  return jobs;
}
export function cancelVideoJob(id) {
  const s = state(); const job = getVideoJob(id);
  if (!job) return null;
  if (!ACTIVE.has(job.status)) return job;
  const entry = s.queue.find(item => item.job.id === id);
  if (entry) entry.controller.abort();
  job.status = 'cancelled'; job.error = '用户已取消。'; job.finishedAt = Date.now(); save(job);
  return job;
}
async function drain() {
  const s = state(); if (s.running) return; s.running = true;
  try {
    while (s.queue.length) {
      const entry = s.queue[0]; const { job } = entry;
      const directory = path.join(videoRoot(), job.id);
      const work = path.join(directory, 'work');
      const controller = entry.controller;
      const timer = setTimeout(() => controller.abort(), LIMITS.timeout);
      const progress = patch => {
        if (controller.signal.aborted) return;
        Object.assign(job, patch); save(job);
      };
      try {
        controller.signal.throwIfAborted(); progress({ status: 'checking' });
        await mkdir(work, { mode: 0o700 });
        const budget = { bytes: 0 };
        let result;
        try { result = await downloadVideo(entry.url, work, { signal: controller.signal, progress, budget }); }
        catch (error) {
          // Never mix bytes from different routes; no fallback on authorization or quota failures.
          if (!entry.backupUrl || controller.signal.aborted || !(error instanceof VideoError) || !/网络连接|传输中断|请求超时|HTTP 50[234]|HTTP 404/.test(error.message)) throw error;
          await rm(work, { recursive: true, force: true }); await mkdir(work, { mode: 0o700 });
          progress({ status: 'checking', downloaded: 0, total: 0, bytes: budget.bytes, notice: '主线路失败，正在从备用线路重新开始。' });
          result = await downloadVideo(entry.backupUrl, work, { signal: controller.signal, progress, budget });
        }
        controller.signal.throwIfAborted();
        const output = path.join(work, 'output.partial.mp4');
        const file = await stat(output);
        if (file.size <= 0 || file.size >= LIMITS.bytes) throw new VideoError('输出文件为空或达到大小上限，不能确认为完整视频。');
        await rename(output, path.join(directory, 'video.mp4'));
        controller.signal.throwIfAborted();
        progress({ ...result, fileBytes: file.size, status: 'completed', finishedAt: Date.now(), savedPath: path.join(directory, 'video.mp4') });
      } catch (error) {
        if (job.status !== 'cancelled') {
          job.status = 'failed'; job.finishedAt = Date.now();
          job.error = controller.signal.aborted ? '任务超过 30 分钟时限，已停止。' : error instanceof VideoError ? error.message : '任务执行失败（文件读写或媒体解析异常）。';
          try { save(job); } catch { /* Keep status in memory if the disk is unavailable. */ }
        }
      } finally {
        clearTimeout(timer);
        await rm(work, { recursive: true, force: true }).catch(() => {});
        if (job.status !== 'completed') await rm(path.join(directory, 'video.mp4'), { force: true }).catch(() => {});
        s.queue.shift();
      }
    }
  } finally { s.running = false; }
}
