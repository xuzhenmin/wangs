"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WatermarkResult, WatermarkSettings } from "../../../lib/article-watermarks";
import { MAX_IMAGES_PER_ARTICLE } from "../../../lib/article-image-limits";

type Preview = { original: string; content: string };
type Props = {
  articleId: string;
  content: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onPreview: (preview: Preview | null) => void;
  onApply: (preview: Preview) => void;
};
const defaults: Omit<WatermarkSettings, "template"> = { relativeWidth: 0.42, mode: "inpaint", search: "bottom-right", threshold: 0.86, opacity: 0.7, padding: 6 };

function rawSources(content: string, articleId: string) {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const all = [...doc.querySelectorAll("img")].map(img => img.getAttribute("src")?.trim() || "");
  const prefix = `/uploads/articles/${articleId}/`;
  return { count: all.length, sources: [...new Set(all.filter(src => src.startsWith(prefix) && /^[0-9a-f]{24}\.(png|jpe?g|webp)$/i.test(src.slice(prefix.length))))] };
}

function replaceSources(content: string, results: WatermarkResult[]) {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const replacements = new Map(results.filter(r => r.status === "processed" && r.localUrl).map(r => [r.source, r.localUrl!]));
  for (const img of doc.querySelectorAll("img")) {
    const replacement = replacements.get(img.getAttribute("src")?.trim() || "");
    if (replacement) { img.setAttribute("src", replacement); img.removeAttribute("srcset"); }
  }
  return doc.body.innerHTML;
}

async function api(body: unknown, signal?: AbortSignal) {
  const response = await fetch("/api/admin/articles/watermarks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录。" : data.detail || `处理失败（HTTP ${response.status}）`);
  return data;
}

export function WatermarkTools({ articleId, content, disabled, onBusy, onPreview, onApply }: Props) {
  const [settings, setSettings] = useState<WatermarkSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<"process" | "calibrate" | "save-template" | null>(null);
  const [calibrationNotice, setCalibrationNotice] = useState("");
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<WatermarkResult[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [region, setRegion] = useState([57, 83, 42, 16]);
  const [sample, setSample] = useState("");
  const sources = useMemo(() => typeof DOMParser === "undefined" ? [] : rawSources(content, articleId).sources, [content, articleId]);
  const selectedSource = sources.includes(sample) ? sample : sources[0] || "";
  const selectedNumber = sources.indexOf(selectedSource) + 1;
  const validRegion = region.every(v => Number.isFinite(v) && v >= 0 && v <= 100) && region[2] > 0 && region[3] > 0 && region[0] + region[2] <= 100 && region[1] + region[3] <= 100;
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    fetch("/api/admin/articles/watermarks", { cache: "no-store", signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? "请重新登录管理员账号。" : "模板加载失败。");
      const data = await response.json();
      setSettings(data.settings); setExpanded(!data.settings);
    }).catch(error => { if (!abort.signal.aborted) setMessage(error.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, []);

  const begin = (nextOperation: "process" | "calibrate" | "save-template" = "process") => {
    if (running.current) return false;
    running.current = true; controller.current = new AbortController(); setBusy(true); setOperation(nextOperation); onBusy(true); return true;
  };
  const finish = () => {
    running.current = false;
    if (mounted.current) { setBusy(false); setOperation(null); onBusy(false); }
  };
  const saveTemplate = async (next: WatermarkSettings) => {
    if (!authorized) { setMessage("请先确认有权处理这些图片。"); return; }
    if (!begin("save-template")) return;
    try {
      const data = await api({ action: "save-template", authorized: true, settings: next }, controller.current!.signal);
      setSettings(data.settings); setMessage("模板和参数已保存，后续文章可以复用。");
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "模板保存失败。"); }
    finally { finish(); }
  };
  const calibrate = async () => {
    if (!authorized) { setCalibrationNotice("尚未开始提取：请先勾选上方的图片处理授权确认。"); return; }
    if (!articleId || !selectedSource) { setCalibrationNotice("尚未开始提取：请先保存草稿并导入原图。"); return; }
    if (!validRegion) { setCalibrationNotice("提取范围无效：宽度和高度必须大于 0，选区不能超出图片边界。"); return; }
    if (!begin("calibrate")) return;
    setCalibrationNotice(`正在从第 ${selectedNumber} 张样图提取黄色水印模板…`);
    try {
      const data = await api({ action: "calibrate", authorized: true, articleId, content, source: selectedSource, region: region.map(v => v / 100) }, controller.current!.signal);
      if (!mounted.current) return;
      const unchanged = settings?.template === data.settings.template;
      setSettings(data.settings);
      setCalibrationNotice(`第 ${selectedNumber} 张样图的模板已提取并保存。${unchanged ? "本次模板与原模板相同。" : "下方模板预览已更新。"}这一步不会改变正文图片；检查模板后，请点击“一键去水印”生成处理结果。`);
    } catch (error) {
      if (mounted.current) setCalibrationNotice(`${controller.current?.signal.aborted ? "提取已停止" : `提取失败：${error instanceof Error ? error.message : "请求失败"}`}。${settings ? "仍显示原模板，本次未更新模板预览。" : "尚未生成模板。"}`);
    }
    finally { finish(); }
  };
  const uploadTemplate = async (file?: File) => {
    if (!file) return;
    if (file.size > 1024 * 1024 || file.type !== "image/png") { setMessage("请选择 1 MB 以内的透明 PNG 水印模板。"); return; }
    const reader = new FileReader();
    reader.onerror = () => setMessage("模板文件读取失败。");
    reader.onload = () => {
      if (!mounted.current) return;
      setSettings({ ...defaults, template: String(reader.result).split(",")[1] });
      setCalibrationNotice("");
      setMessage("已载入模板，请调整参数并保存模板。");
    };
    reader.readAsDataURL(file);
  };

  const run = async () => {
    if (!authorized) { setMessage("请先确认有权处理这些图片。"); return; }
    if (!settings) { setExpanded(true); setMessage("请先提取或上传水印模板。"); return; }
    if (!articleId) { setMessage("请先保存文档草稿，再处理图片。"); return; }
    const current = rawSources(content, articleId);
    if (current.count > MAX_IMAGES_PER_ARTICLE) { setMessage(`当前正文有 ${current.count} 张图片，每篇文章最多处理 ${MAX_IMAGES_PER_ARTICLE} 张。`); return; }
    if (!current.sources.length) { setMessage("没有待处理的本地原图。请先导入外链/Blob；已处理图片和 OSS 图片默认跳过。"); return; }
    if (!begin()) return;
    const original = content, completed: WatermarkResult[] = [];
    const signal = controller.current!.signal;
    setResults([]); setPreview(null); onPreview(null);
    try {
      for (let i = 0; i < current.sources.length; i++) {
        if (signal.aborted) break;
        const source = current.sources[i];
        setMessage(`正在处理 ${i + 1} / ${current.sources.length}，请勿关闭页面…`);
        try {
          const result = await api({ action: "process", authorized: true, articleId, content: original, source, settings }, signal) as WatermarkResult;
          if (result.status === "processed" && result.localUrl) {
            const check = await fetch(result.localUrl, { signal });
            if (!check.ok || !check.headers.get("content-type")?.startsWith("image/")) throw new Error("结果图片无法访问，未加入预览。");
            await check.body?.cancel();
          }
          completed.push(result);
        } catch (error) {
          if (signal.aborted) break;
          const reason = error instanceof Error ? error.message : "请求失败。";
          completed.push({ source, status: "failed", reason });
          if (/登录已过期/.test(reason)) { setResults([...completed]); break; }
        }
        if (!mounted.current) return;
        setResults([...completed]);
      }
      if (!mounted.current) return;
      const successes = completed.filter(r => r.status === "processed").length;
      const skipped = completed.filter(r => r.status === "skipped").length;
      const failed = completed.filter(r => r.status === "failed").length;
      if (successes) {
        const next = { original, content: replaceSources(original, completed) };
        setPreview(next); onPreview(next);
      }
      setMessage(`${signal.aborted ? "已停止。" : "处理结束。"}成功 ${successes}，跳过 ${skipped}，失败 ${failed}${current.sources.length > completed.length ? `，未处理 ${current.sources.length - completed.length}` : ""}。${successes ? "请检查右侧预览，确认后应用到正文；不会自动保存或发布。" : "原图和正文均未改变。"}`);
    } finally { finish(); }
  };

  const stale = preview !== null && preview.original !== content;
  return <section className="watermark-tools" aria-label="文章图片去水印">
    <div className="watermark-actions">
      <button className="localize-images-button" type="button" disabled={disabled || busy || loading} onClick={() => void run()}>{operation === "process" ? "去水印并添加深巷水印中…" : "一键去水印并加深巷水印"}</button>
      <button className="editor-secondary" type="button" disabled={busy} onClick={() => setExpanded(!expanded)}>水印模板与参数 {expanded ? "▴" : "▾"}</button>
      {busy && <button type="button" onClick={() => controller.current?.abort()}>停止处理</button>}
      <small>成功去除旧水印后，添加右下角“深巷”水印（透明度 30%）。只处理本地原图，不自动上传或发布。</small>
    </div>
    <label className="watermark-consent"><input type="checkbox" checked={authorized} disabled={busy} onChange={event => setAuthorized(event.target.checked)} />我有权处理这些图片的水印，并会检查修补结果。</label>
    {message && <p role="status" className="watermark-message">{message}</p>}
    {expanded && <div className="watermark-settings">
      <p>第一次先建立模板，之后可复用。黄色样图提取的模板按不透明水印修补；被遮住的正文、面部等细节无法保证还原。</p>
      <div className="watermark-calibration">
        <label>样图<select value={sources.includes(sample) ? sample : ""} disabled={busy} onChange={event => { setSample(event.target.value); setCalibrationNotice("样图已更换。点击下方提取按钮更新模板；正文图片不会自动改变。"); }}><option value="">使用当前文章第一张本地原图</option>{sources.map((source, i) => <option key={source} value={source}>第 {i + 1} 张 · {source.split("/").at(-1)}</option>)}</select></label>
        {selectedSource && <figure className="watermark-sample">
          <a href={selectedSource} target="_blank" rel="noreferrer" className="watermark-sample-image" aria-label={`查看第 ${selectedNumber} 张完整样图`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={selectedSource} alt={`第 ${selectedNumber} 张样图，框内为模板提取区域`} />
            {validRegion && <span className="watermark-sample-region" style={{ left: `${region[0]}%`, top: `${region[1]}%`, width: `${region[2]}%`, height: `${region[3]}%` }} />}
          </a>
          <figcaption>当前第 {selectedNumber} 张样图 · 框内为提取范围，点击图片可查看原图。调整下面的百分比，让选区只包含黄色水印。</figcaption>
        </figure>}
        <div className="watermark-region">{["左边距 %", "上边距 %", "宽度 %", "高度 %"].map((label, i) => <label key={label}>{label}<input type="number" min="0" max="100" value={region[i]} disabled={busy} onChange={event => { setRegion(region.map((v, n) => n === i ? Number(event.target.value) : v)); setCalibrationNotice("提取范围已调整，请点击提取按钮重新生成模板。"); }} /></label>)}</div>
        <button className="editor-secondary" type="button" disabled={disabled || busy || loading || !articleId || !sources.length} onClick={() => void calibrate()}>{operation === "calibrate" ? "正在提取黄色水印模板…" : "从样图区域提取黄色水印模板"}</button>
        <p role="status" className="watermark-calibration-status">{calibrationNotice || "提取只生成识别模板，不会去除正文图片上的水印。"}</p>
        <label>或上传透明 PNG 模板<input type="file" accept="image/png" disabled={busy} onChange={event => { void uploadTemplate(event.target.files?.[0]); event.target.value = ""; }} /></label>
      </div>
      {settings && <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="watermark-template-preview" src={`data:image/png;base64,${settings.template}`} alt="当前识别模板预览（棋盘背景表示透明，不是处理后的正文图片）" />
        <div className="watermark-parameters">
          <label>处理方式<select disabled={busy} value={settings.mode} onChange={event => setSettings({ ...settings, mode: event.target.value as WatermarkSettings["mode"] })}><option value="inpaint">不透明水印：笔画掩膜修补</option><option value="inverse">半透明水印：反向混合＋局部修补</option></select></label>
          <label>搜索区域<select disabled={busy} value={settings.search} onChange={event => setSettings({ ...settings, search: event.target.value as WatermarkSettings["search"] })}><option value="bottom-right">右下角</option><option value="all">整张图片（较慢）</option></select></label>
          <label>水印占原图宽度 %<input type="number" min="2" max="80" step="0.1" disabled={busy} value={Number((settings.relativeWidth * 100).toFixed(2))} onChange={event => setSettings({ ...settings, relativeWidth: Number(event.target.value) / 100 })} /></label>
          <label>匹配阈值（非成功概率）<input type="number" min="0.75" max="0.99" step="0.01" disabled={busy} value={settings.threshold} onChange={event => setSettings({ ...settings, threshold: Number(event.target.value) })} /></label>
          <label>原水印叠加不透明度 %<input type="number" min="5" max="100" disabled={busy || settings.mode !== "inverse"} value={Math.round(settings.opacity * 100)} onChange={event => setSettings({ ...settings, opacity: Number(event.target.value) / 100 })} /></label>
          <label>笔画外扩像素（含阴影）<input type="number" min="0" max="12" disabled={busy} value={settings.padding} onChange={event => setSettings({ ...settings, padding: Number(event.target.value) })} /></label>
        </div>
        <button className="editor-secondary" type="button" disabled={busy || disabled} onClick={() => void saveTemplate(settings)}>保存模板与参数</button>
      </>}
    </div>}
    {results.length > 0 && <details className="watermark-results" open><summary>逐张结果与对比（{results.length}）</summary>{results.map((result, i) => <div key={result.source} className="watermark-result">
      <p><b>第 {i + 1} 张 · {result.status === "processed" ? "待确认" : result.status === "skipped" ? "跳过" : "失败"}</b>{typeof result.confidence === "number" && <span> 匹配分数 {result.confidence.toFixed(3)}</span>}<br />{result.reason}</p>
      {result.localUrl && <div className="watermark-comparison">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <a href={result.source} target="_blank" rel="noreferrer"><img src={result.source} alt={`第 ${i + 1} 张原图`} loading="lazy" />查看原图 ↗</a>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <a href={result.localUrl} target="_blank" rel="noreferrer"><img src={result.localUrl} alt={`第 ${i + 1} 张去水印并添加深巷水印的结果`} loading="lazy" />查看结果 ↗</a>
      </div>}
    </div>)}</details>}
    {preview && <div className="watermark-actions">
      {stale && <p role="alert">正文已变化，本次预览已失效。请重新处理，避免覆盖新修改。</p>}
      <button className="localize-images-button" type="button" disabled={busy || disabled || stale} onClick={() => { onApply(preview); setPreview(null); onPreview(null); setMessage("已应用到编辑器，请保存草稿或发布更新。原始图片未覆盖。"); }}>确认效果并应用到正文</button>
      <button className="editor-secondary" type="button" disabled={busy} onClick={() => { setPreview(null); onPreview(null); setResults([]); setMessage("已放弃本次替换，正文未改变。"); }}>放弃替换</button>
    </div>}
  </section>;
}
