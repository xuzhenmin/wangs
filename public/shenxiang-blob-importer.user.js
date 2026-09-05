// ==UserScript==
// @name         深巷 Blob 图片导入助手
// @namespace    shenxiang.local
// @version      1.0.0
// @description  将原网页中的 Blob 图片批量发送到深巷内容编辑器
// @match        http://*/*
// @match        https://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const TASK_KEY = "shenxiang-current-image-import-task";
  const BUTTON_ID = "shenxiang-blob-import-button";
  const isEditorPage = location.pathname.startsWith("/ops-7q4m/editor");

  function activeTask() {
    const task = GM_getValue(TASK_KEY, null);
    if (!task || !task.id || !task.uploadToken || !task.apiBase || task.expiresAt <= Date.now()) return null;
    return task;
  }

  function blobImages(task) {
    const unique = new Map();
    for (const image of document.querySelectorAll("img")) {
      const sourceUrl = image.currentSrc || image.src || image.getAttribute("src") || "";
      if (sourceUrl.startsWith("blob:") && !unique.has(sourceUrl)) {
        unique.set(sourceUrl, { sourceUrl, altText: image.alt || "" });
      }
    }
    if (task?.requestedSources?.length) {
      return task.requestedSources.map((sourceUrl) => unique.get(sourceUrl) || { sourceUrl, altText: "" });
    }
    return [...unique.values()];
  }

  function uploadRequest(url, form) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        data: form,
        timeout: 30000,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) resolve(response);
          else reject(new Error(`上传接口返回 ${response.status}`));
        },
        ontimeout: () => reject(new Error("上传超时")),
        onerror: () => reject(new Error("上传请求失败")),
      });
    });
  }

  function imageForm(task, image, imageOrder, totalImages, file, error) {
    const form = new FormData();
    form.append("token", task.uploadToken);
    form.append("sourceUrl", image.sourceUrl);
    form.append("imageOrder", String(imageOrder));
    form.append("totalImages", String(totalImages));
    form.append("altText", image.altText);
    if (file) form.append("file", file, `blob-image-${imageOrder + 1}.${file.type.split("/")[1] || "png"}`);
    if (error) form.append("error", error);
    return form;
  }

  async function reportFailure(task, image, imageOrder, totalImages, message) {
    try {
      const form = imageForm(task, image, imageOrder, totalImages, null, message);
      await uploadRequest(`${task.apiBase}/api/image-import/${task.id}`, form);
    } catch {
      // The editor will keep polling and report an expired or incomplete task.
    }
  }

  async function runImport(button) {
    const task = activeTask();
    if (!task) {
      alert("没有可用的导入任务。请先在深巷内容编辑器中点击“处理待处理图片”。");
      return;
    }
    const images = blobImages(task);
    if (!images.length) {
      alert("当前页面没有可读取的 Blob 图片。请确认这是产生这些图片地址的原网页，并且页面没有刷新。");
      return;
    }
    if (images.length > 20) {
      alert("一次最多导入 20 张 Blob 图片。");
      return;
    }
    if (!confirm(`准备向深巷编辑器发送 ${images.length} 张 Blob 图片，是否继续？`)) return;

    button.disabled = true;
    button.dataset.busy = "true";
    let completed = 0;
    let failed = 0;
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      button.textContent = `正在发送 ${index + 1}/${images.length}`;
      try {
        const pageFetch = typeof unsafeWindow !== "undefined" && unsafeWindow.fetch
          ? unsafeWindow.fetch.bind(unsafeWindow)
          : window.fetch.bind(window);
        const response = await pageFetch(image.sourceUrl);
        if (!response.ok) throw new Error(`读取图片失败：${response.status}`);
        const file = await response.blob();
        if (!file.type.startsWith("image/")) throw new Error("Blob 内容不是图片");
        const form = imageForm(task, image, index, images.length, file, "");
        await uploadRequest(`${task.apiBase}/api/image-import/${task.id}`, form);
        completed += 1;
      } catch (error) {
        failed += 1;
        await reportFailure(task, image, index, images.length, error instanceof Error ? error.message : "图片读取失败");
      }
    }
    button.disabled = false;
    button.textContent = failed ? `已发送 ${completed}，失败 ${failed}` : `已发送 ${completed} 张图片`;
    alert(failed
      ? `处理完成：成功 ${completed} 张，失败 ${failed} 张。请返回编辑器查看详情。`
      : `${completed} 张图片已发送，请返回编辑器查看预览并保存。`);
    GM_setValue(TASK_KEY, null);
    window.setTimeout(() => {
      delete button.dataset.busy;
      refreshButton();
    }, 5000);
  }

  function refreshButton() {
    if (isEditorPage) return;
    const images = blobImages(null);
    let button = document.getElementById(BUTTON_ID);
    if (!images.length) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;border:0;border-radius:4px;padding:13px 18px;background:#b73828;color:#fff;font:700 13px/1.2 system-ui;box-shadow:0 8px 28px #0005;cursor:pointer";
      button.addEventListener("click", () => void runImport(button));
      document.documentElement.appendChild(button);
    }
    if (button.dataset.busy === "true") return;
    const label = activeTask() ? `发送 ${images.length} 张图片到编辑器` : `发现 ${images.length} 张 Blob 图片`;
    if (button.textContent !== label) button.textContent = label;
  }

  if (isEditorPage) {
    window.addEventListener("shenxiang:image-import-task", (event) => {
      if (!(event instanceof CustomEvent) || !event.detail) return;
      GM_setValue(TASK_KEY, event.detail);
      window.dispatchEvent(new CustomEvent("shenxiang:image-import-task-saved", { detail: { id: event.detail.id } }));
    });
  } else {
    refreshButton();
    const observer = new MutationObserver(() => refreshButton());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    GM_addValueChangeListener(TASK_KEY, () => refreshButton());
    window.setInterval(refreshButton, 3000);
  }
})();
