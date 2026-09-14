// ==UserScript==
// @name         深巷 本地视频保存助手
// @namespace    shenxiang.local
// @version      1.0.0
// @description  手动选择有权保存的 DPlayer HLS 视频，交给本地深巷服务处理
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  let busy = false;
  function videos() {
    const found = new Map();
    for (const node of document.querySelectorAll('.dplayer[config]')) {
      try {
        const config = JSON.parse(node.getAttribute('config'));
        const video = config.video;
        if (!video || video.type !== 'hls' || typeof video.url !== 'string') continue;
        const url = new URL(video.url, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const backup = Array.isArray(video.urls) ? video.urls.find(item => {
          try { return new URL(item.url, location.href).hostname !== url.hostname; } catch { return false; }
        }) : null;
        // Do not export webpage titles, cookies, ads, credentials or browser Blob references.
        const key = url.origin + url.pathname;
        if (!found.has(key)) found.set(key, { title: `网页视频 ${found.size + 1}`, url: url.href, ...(backup ? { backupUrl: new URL(backup.url, location.href).href } : {}) });
      } catch { /* Skip malformed player config. */ }
    }
    return [...found.values()];
  }
  async function start() {
    if (busy) return;
    const items = videos();
    if (!items.length) { alert('没有找到可识别的 DPlayer HLS 配置。该助手不会提取 DRM 或浏览器 Blob。'); return; }
    const selection = prompt(`找到 ${items.length} 个视频。请输入要保存的序号，逗号分隔，每批最多 6 个：`, items.slice(0, 6).map((_, i) => i + 1).join(','));
    if (selection === null) return;
    const numbers = [...new Set(selection.split(/[,，\s]+/).filter(Boolean).map(Number))];
    if (!numbers.length || numbers.length > 6 || numbers.some(n => !Number.isInteger(n) || n < 1 || n > items.length)) { alert('视频序号无效，每批请选择 1–6 个。'); return; }
    const baseInput = prompt('请输入你本机深巷服务地址（只支持 localhost / 127.0.0.1）：', 'http://127.0.0.1:3217');
    if (!baseInput) return;
    let base;
    try {
      const address = new URL(baseInput);
      if (!['127.0.0.1', 'localhost'].includes(address.hostname) || !['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error();
      base = address.origin;
    } catch { alert('只允许本机 localhost / 127.0.0.1 服务地址，不发送到第三方服务器。'); return; }
    const token = prompt('粘贴“本地视频保存”后台生成的配对码（10 分钟有效，单次使用）：');
    if (!token) return;
    if (!confirm(`确认你有权保存所选 ${numbers.length} 个视频，并将它们的播放配置发送到 ${base}？\n仅保存到本地，不自动发布。`)) return;
    busy = true;
    GM_xmlhttpRequest({
      method: 'POST', url: `${base}/api/video-imports`, anonymous: true,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.trim()}` },
      data: JSON.stringify({ authorized: true, videos: numbers.map(n => items[n - 1]) }), timeout: 20000,
      onload(response) {
        busy = false;
        let result;
        try { result = JSON.parse(response.responseText); } catch { alert(`本地服务返回异常（HTTP ${response.status}），请检查服务地址。`); return; }
        if (response.status !== 202) { alert(result.error || `提交失败（HTTP ${response.status}）。请重新生成配对码后重试。`); return; }
        alert(`已提交 ${result.jobs.length} 个任务。\n请打开 ${base}/ops-7q4m/videos 查看进度、失败原因和预览。`);
      },
      onerror() { busy = false; alert('无法连接本地服务。请检查服务是否运行，以及油猴是否允许访问 localhost / 127.0.0.1。'); },
      ontimeout() { busy = false; alert('提交超时。请先到后台确认是否已创建任务，避免重复提交；需要重试时重新生成配对码。'); },
    });
  }
  GM_registerMenuCommand('保存视频到本地', start);
  if (!videos().length) return;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:90px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.textContent = '保存视频到本地';
  button.style.cssText = 'background:#222b3b;color:#f1cc85;border:1px solid #d4ad6c;border-radius:10px;padding:12px 18px;cursor:pointer;font:14px sans-serif';
  button.addEventListener('click', start); shadow.append(button); document.body.append(host);
})();
