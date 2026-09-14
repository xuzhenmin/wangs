'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { VideoJob } from '../../../lib/video-imports.mjs';
import styles from './videos.module.css';

const names: Record<VideoJob['status'], string> = { queued: '排队', checking: '检查资源', downloading: '下载中', muxing: '封装中', verifying: '校验中', completed: '成功', failed: '失败', cancelled: '已取消' };
const active = (job: VideoJob) => ['queued', 'checking', 'downloading', 'muxing', 'verifying'].includes(job.status);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const hasCurrentPublication = (job: VideoJob, base: string | null) => !!base && job.publication?.status === 'uploaded' && job.publication.url === `${base}/${job.id}/video.mp4`;

export default function VideosPage() {
  const [auth, setAuth] = useState<'checking' | 'ready' | 'required'>('checking');
  const [password, setPassword] = useState('');
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [tools, setTools] = useState<{ ready: boolean; message: string } | null>(null);
  const [oss, setOss] = useState<{ ready: boolean; message: string } | null>(null);
  const [articleVideoBaseUrl, setArticleVideoBaseUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<{ token: string; expiresAt: number } | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setAuth('required'); setJobs([]); setTools(null); setOss(null); setArticleVideoBaseUrl(null);
    setPair(null); setPreview(null); setUrl(''); setTitle('');
    setAuthorized(false); setNotice('');
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/admin/video-imports', { cache: 'no-store', signal });
    if (response.status === 401) { clearSession(); return; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '任务列表读取失败。');
    setAuth('ready'); setJobs(result.jobs); setTools(result.tools); setOss(result.oss || null);
    setArticleVideoBaseUrl(typeof result.articleVideoBaseUrl === 'string' ? result.articleVideoBaseUrl : null);
  }, [clearSession]);

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await load(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '网络连接失败。'); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load]);

  async function action(path: string, body?: unknown) {
    setError(''); setNotice(''); setBusy(true);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (response.status === 401) clearSession();
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '操作失败。');
      return result;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '网络连接失败。'); return null; }
    finally { setBusy(false); }
  }

  async function uploadVideo(job: VideoJob) {
    if (!window.confirm('上传后将生成供文章访客播放的 OSS 长期地址，拥有该地址的人可以访问视频。本地原文件会保留，文章不会自动发布。\n\n请确认你有权公开此视频。是否继续上传？')) return;
    const result = await action(`/api/admin/video-imports/${job.id}/oss`, { authorized: true });
    if (result?.job) {
      setJobs(current => current.map(item => item.id === result.job.id ? result.job : item));
      setNotice(result.job.publication?.status === 'uploaded' ? '视频已上传 OSS，可在文章编辑器中插入。' : '已开始上传 OSS，可以留在此页查看进度。上传不会自动发布文章。');
    }
  }

  if (auth !== 'ready') return <main className="ops-login"><div className="ops-login-card">
    <Link href="/" className="brand small">深<span>巷</span></Link><h1>本地视频保存</h1>
    {auth === 'required' ? <form onSubmit={async event => {
      event.preventDefault();
      if (await action('/api/admin/login', { password })) { setPassword(''); await load().catch(() => setError('任务列表读取失败。')); }
    }}>
      <label>超级管理员密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy}>安全登录</button>
    </form> : <p>正在验证管理员会话…</p>}
    {error && <p role="alert">{error}</p>}
    <Link href="/ops-7q4m">返回后台</Link>
  </div></main>;

  return <main className="ops-shell ops-location-shell">
    <aside className="ops-side"><Link className="brand small" href="/">深<span>巷</span></Link>
      <nav className="ops-nav" aria-label="后台管理">
        <Link href="/ops-7q4m"><i>⌖</i>精确位置</Link>
        <Link href="/ops-7q4m/editor"><i>✎</i>内容管理</Link>
        <Link href="/ops-7q4m/articles"><i>▤</i>文章列表管理</Link>
        <Link href="/ops-7q4m/videos" className="current" aria-current="page"><i>▷</i>本地视频保存</Link>
      </nav>
      <button className="ops-exit" disabled={busy} onClick={async () => { if (await action('/api/admin/logout')) clearSession(); }}>安全退出</button>
    </aside>
    <section className={`ops-main ${styles.main}`}>
      <header className="ops-head"><div><small>SUPER ADMIN / VIDEOS</small><h1>本地视频保存</h1></div><Link href="/ops-7q4m/editor">返回编辑器</Link></header>
      <p>先保存视频到当前服务所在电脑，再手动上传 OSS。在文章编辑器中选择视频插入正文后，按需保存草稿或发布文章。最近 100 个任务每 4 秒刷新。</p>
      <p className={styles.workflow}>本地保存 → 手动上传 OSS → 编辑器插入视频 → 保存 / 发布文章</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {oss && !oss.ready && <section className={styles.card}>
        <h2>OSS 上传暂不可用</h2><p>{oss.message || '请先完成 OSS 配置，再上传视频。'}</p>
        <p>这不影响本地视频保存、预览和下载。上传按钮不会自动触发任何远端操作。</p>
      </section>}
      {tools && !tools.ready && <section className={styles.card}>
        <h2>需要安装 FFmpeg 和 ffprobe</h2><p role="alert">{tools.message}</p>
        <p>macOS（已安装 Homebrew）：<code>brew install ffmpeg</code></p>
        <p>安装后重启本地服务。若不在 PATH 中，请在本地环境配置 VIDEO_FFMPEG_PATH 和 VIDEO_FFPROBE_PATH 为可执行文件的绝对路径。</p>
        <p>启动脚本不会自动安装任何依赖。</p>
      </section>}
      <section className={styles.card}>
        <h2>从网页选择视频</h2>
        <ol><li><a href="/shenxiang-video-importer.user.js" target="_blank" rel="noreferrer">安装视频导入油猴脚本</a>（独立于图片导入助手）。</li>
          <li>生成一次性配对码，复制后在原网页点击“保存视频到本地”。</li>
          <li>选择序号并输入本地服务地址、配对码；确认后回到此页查看进度。</li></ol>
        <button className="editor-secondary" disabled={busy || !tools?.ready} onClick={async () => {
          const result = await action('/api/admin/video-imports/pair'); if (result) setPair(result);
        }}>生成配对码</button>
        {pair && <div className={styles.pair}>
          <label>一次性配对码（10 分钟有效，仅允许提交一批）<input readOnly value={pair.token} onFocus={event => event.target.select()} /></label>
          <button className="editor-secondary" onClick={async () => {
            try { await navigator.clipboard.writeText(pair.token); setNotice('配对码已复制。'); }
            catch { setNotice('无法自动复制，请选中输入框中的配对码手动复制。'); }
          }}>复制</button>
          <p>不要把配对码发给其他人。提交后即失效；如提交失败，请重新生成。</p>
        </div>}
      </section>
      <section className={styles.card}>
        <h2>手动添加 HLS 视频</h2>
        <form className={styles.form} onSubmit={async event => {
          event.preventDefault();
          const result = await action('/api/admin/video-imports', { authorized, videos: [{ title: title || '手动导入视频', url }] });
          if (result) { setUrl(''); setNotice('任务已加入队列。'); await load().catch(() => {}); }
        }}>
          <label>名称<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="可选" /></label>
          <label>HLS 播放清单地址<input type="url" required value={url} maxLength={8192} onChange={event => setUrl(event.target.value)} placeholder="https://…/playlist.m3u8" autoComplete="off" /></label>
          <label className={styles.checkbox}><input type="checkbox" required checked={authorized} onChange={event => setAuthorized(event.target.checked)} />我确认有权保存此视频</label>
          <button className="editor-secondary" disabled={busy || !tools?.ready || !authorized}>添加保存任务</button>
        </form>
      </section>
      <section className={styles.card}><h2>保存任务</h2><p>单任务最多 1 GiB / 2 小时视频，运行限时 30 分钟；逐个处理。支持无加密及标准 AES-128（identity）点播；不支持 DRM、SAMPLE-AES、直播及字节范围清单。</p>
        {!jobs.length && <p>暂无任务。保存完成后可预览、下载文件，或手动上传 OSS 供文章使用。</p>}
        <div className={styles.jobs}>{jobs.map(job => <article key={job.id} className={styles.job}>
          <div className={styles.row}><h3>{job.title || '未命名视频'}</h3><strong>{names[job.status]}</strong></div>
          <small>{job.sourceHost} · {new Date(job.createdAt).toLocaleString('zh-CN')}</small>
          <p>{job.downloaded} / {job.total || '待识别'} 个分片 · {megabytes(job.bytes)}{job.duration ? ` · ${Math.round(job.duration)} 秒` : ''}</p>
          {job.status === 'downloading' && <progress aria-label="已保存分片" value={job.downloaded} max={Math.max(1, job.total)} />}
          {job.error && <p className={styles.error}>{job.error}</p>}{job.notice && <p>{job.notice}</p>}
          <div className={styles.actions}>
            {active(job) && <button disabled={busy} onClick={async () => { await action(`/api/admin/video-imports/${job.id}/cancel`); await load().catch(() => {}); }}>取消任务</button>}
            {job.status === 'completed' && <><button onClick={() => setPreview(preview === job.id ? null : job.id)}>{preview === job.id ? '关闭预览' : '预览视频'}</button><a href={`/api/admin/video-imports/${job.id}/file?download=1`}>下载 MP4（{megabytes(job.fileBytes || 0)}）</a></>}
          </div>
          {job.status === 'failed' && <p>重试：从原网页重新提交，或在上方填写新的有效地址。已过期的地址不会被自动复用。</p>}
          {job.savedPath && <p className={styles.path}>保存位置：{job.savedPath}</p>}
          {preview === job.id && <video className={styles.preview} controls playsInline preload="metadata" src={`/api/admin/video-imports/${job.id}/file`} />}
          {job.status === 'completed' && <section className={styles.publication} aria-label="OSS 上传">
            <div className={styles.row}><h4>文章视频 / OSS</h4><strong>{hasCurrentPublication(job, articleVideoBaseUrl) ? '已上传' : job.publication?.status === 'uploaded' ? '需要重新上传' : job.publication?.status === 'uploading' ? '上传中' : job.publication?.status === 'failed' ? '上传失败' : '未上传'}</strong></div>
            {job.publication?.status === 'uploading' ? <>
              <p role="status">正在上传到 OSS：{Math.round(Math.min(100, Math.max(0, job.publication.progress || 0)))}%</p>
              <progress aria-label="OSS 上传进度" value={Math.min(100, Math.max(0, job.publication.progress || 0))} max={100} />
              <p>上传在后台继续，本地原文件保持不变。完成后可前往编辑器插入视频。</p>
            </> : hasCurrentPublication(job, articleVideoBaseUrl) ? <>
              <label className={styles.url}>OSS 视频地址<input readOnly value={job.publication?.url || ''} onFocus={event => event.target.select()} /></label>
              <div className={styles.actions}>
                <button onClick={async () => {
                  try { await navigator.clipboard.writeText(job.publication!.url!); setNotice('OSS 视频地址已复制。'); }
                  catch { setNotice('无法自动复制，请选中 OSS 视频地址输入框手动复制。'); }
                }}>复制视频地址</button>
                <Link href="/ops-7q4m/editor">去编辑器插入</Link>
              </div>
              <p>在编辑器的插入视频窗口中选择此视频，再保存草稿或发布文章。上传本身不会修改文章。</p>
            </> : <>
              {job.publication?.error && <p className={styles.error} role="alert">{job.publication.error}</p>}
              {job.publication?.status === 'uploaded' && <p className={styles.hint}>此前上传的地址与当前 OSS 配置不一致，不能直接插入文章。请检查配置后，按当前配置重新上传。本地原文件仍保留。</p>}
              <p>上传后使用 OSS 地址供文章访客播放，本地原文件保留。仅在点击并确认后上传。</p>
              <button disabled={busy || !oss?.ready} onClick={() => { void uploadVideo(job); }}>{job.publication?.status === 'uploaded' ? '按当前配置重新上传 OSS' : job.publication?.status === 'failed' ? '重试上传 OSS' : '上传 OSS'}</button>
              {!oss?.ready && <p className={styles.hint}>OSS 配置就绪后即可上传；仍可预览或下载本地文件。</p>}
            </>}
          </section>}
        </article>)}</div>
      </section>
    </section>
  </main>;
}
