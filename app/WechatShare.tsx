"use client";

import { useEffect } from "react";

type ShareData = { title: string; desc: string; link: string; imgUrl: string };
type SdkResult = { errMsg?: string };
type Sdk = {
  config: (data: Record<string, unknown>) => void;
  ready: (callback: () => void) => void;
  error: (callback: (result: SdkResult) => void) => void;
  updateAppMessageShareData: (data: ShareData & { fail: (result: SdkResult) => void }) => void;
  updateTimelineShareData: (data: Omit<ShareData, "desc"> & { fail: (result: SdkResult) => void }) => void;
};
declare global { interface Window { wx?: Sdk } }
let sdkPromise: Promise<Sdk> | undefined;

function loadSdk() {
  if (window.wx) return Promise.resolve(window.wx);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<Sdk>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
    script.async = true;
    const timer = window.setTimeout(() => { script.remove(); reject(new Error("微信分享组件加载超时")); }, 10000);
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.wx) resolve(window.wx); else reject(new Error("微信分享组件不可用"));
    };
    script.onerror = () => { window.clearTimeout(timer); script.remove(); reject(new Error("微信分享组件加载失败")); };
    document.head.appendChild(script);
  }).catch((error) => { sdkPromise = undefined; throw error; });
  return sdkPromise;
}

export default function WechatShare({ title, desc, link, imgUrl }: ShareData) {
  useEffect(() => {
    if (!/MicroMessenger/i.test(navigator.userAgent)) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const report = (result: SdkResult) => console.warn("[wechat-share]", result.errMsg || "分享信息设置失败");
    void (async () => {
      // iOS WKWebView signs the initial document URL across client-side navigation.
      const entry = performance.getEntriesByType("navigation")[0]?.name;
      const pageUrl = /iPhone|iPad|iPod/i.test(navigator.userAgent) && entry ? entry : window.location.href;
      const url = pageUrl.split("#", 1)[0];
      const response = await fetch(`/api/wechat/config?url=${encodeURIComponent(url)}`, { signal: controller.signal, cache: "no-store" });
      const config = await response.json();
      if (!response.ok) throw new Error(config.message || "微信分享配置加载失败");
      if (!config.enabled || cancelled) return;
      const wx = await loadSdk();
      if (cancelled) return;
      const data = { title, desc, link: new URL(link, location.origin).href, imgUrl: new URL(imgUrl, location.origin).href };
      wx.error((result) => { if (!cancelled) report(result); });
      wx.config({ debug: false, appId: config.appId, timestamp: config.timestamp, nonceStr: config.nonceStr, signature: config.signature, jsApiList: config.jsApiList });
      wx.ready(() => {
        if (cancelled) return;
        wx.updateAppMessageShareData({ ...data, fail: report });
        wx.updateTimelineShareData({ title: data.title, link: data.link, imgUrl: data.imgUrl, fail: report });
      });
    })().catch((error) => {
      if (!cancelled) console.warn("[wechat-share]", error instanceof Error ? error.message : "微信分享暂时不可用");
    }).finally(() => window.clearTimeout(timeout));
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [title, desc, link, imgUrl]);
  return null;
}
