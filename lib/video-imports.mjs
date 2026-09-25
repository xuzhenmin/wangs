import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkTools, downloadVideo, recoverVideoTail, sourceURL, VideoError, VideoTailError, LIMITS } from './video-download.mjs';

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
  const value = { jobs: new Map(), queue: [], pairs: new Map(), recoveryLocks: new Set(), running: false, health: null, healthAt: 0 };
  for (const name of readdirSync(videoRoot())) {
    if (!ID.test(name)) continue;
    try {
      const job = JSON.parse(readFileSync(path.join(videoRoot(), name, 'result.json'), 'utf8'));
      if (job.id !== name) continue;
      if (ACTIVE.has(job.status) || (job.tailRecovery && job.status === 'cancelled')) {
        job.status = 'failed'; job.error = job.tailRecovery ? '服务重启中断了合成；保留分片仍可再次确认合成。' : '服务重启中断了任务，请在原页面重新提交（首版不支持断点续传）。';
        job.finishedAt = Date.now(); save(job);
      }
      if (job.publication?.status === 'uploading') {
        job.publication = { kind: job.publication.kind, assetId: job.publication.assetId, status: 'failed', progress: 0, error: '服务重启中断了 OSS 上传；本地视频仍然保留，请重新上传。' };
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
  if ([...s.jobs.values()].filter(job => ACTIVE.has(job.status) || job.tailRecovery).length + videos.length > 12) throw new VideoError('最多保留 12 个未完成任务（含等待尾段确认）；请先合成或丢弃保留分片。');
  const health = await toolsStatus();
  if (!health.ready) throw new VideoError(health.message);
  // Re-check after the asynchronous tool probe.
  if ([...s.jobs.values()].filter(job => ACTIVE.has(job.status) || job.tailRecovery).length + videos.length > 12) throw new VideoError('队列已满，请先处理等待尾段确认的任务。');
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

function tailJob(id) {
  const s = state(), job = getVideoJob(id);
  if (!job) throw new VideoError('任务不存在。');
  if (job.status !== 'failed' || !job.tailRecovery) throw new VideoError('此任务没有可合成的失败尾段。');
  if (s.queue.some(entry => entry.job.id === id) || s.recoveryLocks?.has(id)) throw new VideoError('任务仍在处理，请稍后再试。');
  return { s, job };
}
export function confirmVideoTail(id) {
  const { s, job } = tailJob(id);
  const previous = { status: job.status, error: job.error, notice: job.notice, finishedAt: job.finishedAt };
  Object.assign(job, { status: 'queued', error: '', notice: '已确认忽略最后一个分片，正在等待合成。' });
  delete job.finishedAt;
  try { save(job); } catch (error) { Object.assign(job, previous); throw error; }
  s.queue.push({ job, tailOnly: true, controller: new AbortController() });
  void drain();
  return job;
}
export async function discardVideoTail(id) {
  const { s, job } = tailJob(id);
  const locks = s.recoveryLocks ||= new Set(); locks.add(id);
  try {
    await rm(path.join(videoRoot(), id, 'work'), { recursive: true, force: true });
    delete job.tailRecovery;
    job.notice = '已手动丢弃保留分片；如需保存视频，请从来源页面重新提交。';
    save(job); return job;
  } finally { locks.delete(id); }
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
        if (!entry.tailOnly) await mkdir(work, { mode: 0o700 });
        const budget = { bytes: 0 };
        let result;
        try { result = entry.tailOnly
          ? await recoverVideoTail(work, { signal: controller.signal, progress })
          : await downloadVideo(entry.url, work, { signal: controller.signal, progress, budget }); }
        catch (error) {
          // Never mix bytes from different routes; no fallback on authorization or quota failures.
          if (error instanceof VideoTailError || !entry.backupUrl || controller.signal.aborted || !(error instanceof VideoError) || !/网络连接|传输中断|请求超时|HTTP 50[234]|HTTP 404/.test(error.message)) throw error;
          await rm(work, { recursive: true, force: true }); await mkdir(work, { mode: 0o700 });
          progress({ status: 'checking', downloaded: 0, total: 0, bytes: budget.bytes, notice: '主线路失败，正在从备用线路重新开始。' });
          result = await downloadVideo(entry.backupUrl, work, { signal: controller.signal, progress, budget });
          progress({ notice: '已通过备用线路保存视频。' });
        }
        controller.signal.throwIfAborted();
        const output = path.join(work, 'output.partial.mp4');
        const file = await stat(output);
        if (file.size <= 0 || file.size >= LIMITS.bytes) throw new VideoError('输出文件为空或达到大小上限，不能确认为完整视频。');
        await rename(output, path.join(directory, 'video.mp4'));
        controller.signal.throwIfAborted();
        const recovery = job.tailRecovery;
        delete job.tailRecovery;
        try {
          progress({ ...result, fileBytes: file.size, status: 'completed', finishedAt: Date.now(), savedPath: path.join(directory, 'video.mp4'),
            ...(entry.tailOnly ? { notice: `已合成，缺少尾段约 ${result.incomplete.missingSeconds.toFixed(2)} 秒；不是完整原视频。` } : {}) });
        } catch (error) { if (recovery) job.tailRecovery = recovery; throw error; }
      } catch (error) {
        if (job.status !== 'cancelled') {
          job.status = 'failed'; job.finishedAt = Date.now();
          if (error instanceof VideoTailError && !controller.signal.aborted) job.tailRecovery = error.recovery;
          job.error = controller.signal.aborted ? '任务超过 30 分钟时限，已停止。' : error instanceof VideoError ? error.message : '任务执行失败（文件读写或媒体解析异常）。';
          job.notice = job.tailRecovery ? '已保留分片，等待手动确认；不会自动忽略尾段或从备用线路重新下载。' : job.notice ? '主线路与备用线路均未完成，任务已停止。' : undefined;
          try { save(job); } catch { /* Keep status in memory if the disk is unavailable. */ }
        }
      } finally {
        clearTimeout(timer);
        if (entry.tailOnly && job.status === 'cancelled' && job.tailRecovery) {
          job.status = 'failed'; job.error = '已取消合成；保留分片仍可再次确认。';
          job.notice = '分片未删除，可重新合成或手动丢弃。';
          try { save(job); } catch { /* Keep recovery available in memory. */ }
        }
        if (job.tailRecovery && job.status !== 'completed' && job.status !== 'cancelled') {
          await rm(path.join(work, 'output.partial.mp4'), { force: true }).catch(() => {});
        } else {
          await rm(work, { recursive: true, force: true }).catch(() => {});
          if (job.tailRecovery) { delete job.tailRecovery; try { save(job); } catch { /* Status remains in memory. */ } }
        }
        if (job.status !== 'completed') await rm(path.join(directory, 'video.mp4'), { force: true }).catch(() => {});
        s.queue.shift();
      }
    }
  } finally { s.running = false; }
}
