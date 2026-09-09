import sharp from 'sharp';
import { SHENXIANG_WATERMARK_SVG } from './shenxiang-watermark.mjs';

const PIXELS = 12_000_000;

async function decode(input, template = false) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > (template ? 1024 * 1024 : 8 * 1024 * 1024)) throw new Error('图片为空或超过大小限制。');
  const image = sharp(bytes, { limitInputPixels: template ? 1_000_000 : PIXELS });
  const meta = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) > 1) throw new Error('仅处理静态 PNG、JPEG、WebP，不支持动画或 SVG。');
  return image.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

// Calibrate only the selected color inside the user-selected region. Black
// extraction is conservative: dark, near-neutral pixels, not arbitrary shadows.
export async function createColorTemplate(input, region, color = 'yellow') {
  if (!['yellow', 'black'].includes(color)) throw new Error('提取颜色无效，请选择黄色或黑色。');
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) throw new Error('模板区域不合法。');
  const { data, info } = await decode(input);
  const [rx, ry, rw, rh] = region;
  if (region.length !== 4 || !region.every(Number.isFinite) || rx < 0 || ry < 0 || rw <= 0 || rh <= 0 || rx + rw > 1.001 || ry + rh > 1.001) throw new Error('模板区域不合法。');
  const x = Math.round(rx * info.width), y = Math.round(ry * info.height);
  const width = Math.min(Math.round(rw * info.width), info.width - x);
  const height = Math.min(Math.round(rh * info.height), info.height - y);
  if (width < 16 || height < 8 || width * height > 1_000_000) throw new Error('模板区域过小或过大。');
  const rgba = Buffer.alloc(width * height * 4);
  let count = 0;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const p = ((y + j) * info.width + x + i) * 4, q = (j * width + i) * 4;
    const [r, g, b] = data.subarray(p, p + 3);
    const matches = color === 'yellow'
      ? r > 160 && g > 90 && g < r * 0.94 && b < g * 0.65 && r - b > 85
      : Math.max(r, g, b) <= 95 && Math.max(r, g, b) - Math.min(r, g, b) <= 35 && data[p + 3] >= 128;
    if (matches) {
      rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b; rgba[q + 3] = 255; count++;
    }
  }
  if (count < 80 || count / (width * height) > 0.8) throw new Error(`没有提取到可靠的${color === 'yellow' ? '黄色' : '黑色'}文字，请调整框选区域，避开同色背景。`);
  const template = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { template: template.toString('base64'), extractionColor: color, relativeWidth: width / info.width, mode: 'inpaint', search: 'bottom-right', threshold: 0.86, opacity: 0.7, padding: 6 };
}

// Preserve the existing offline calibration entry point.
export const createYellowTemplate = (input, region) => createColorTemplate(input, region, 'yellow');

export function validateSettings(settings) {
  if (!settings || !['inpaint', 'inverse'].includes(settings.mode) || !['bottom-right', 'all'].includes(settings.search)) throw new Error('水印处理模式无效。');
  if (settings.extractionColor !== undefined && !['yellow', 'black'].includes(settings.extractionColor)) throw new Error('提取颜色无效，请选择黄色或黑色。');
  for (const [key, min, max] of [['relativeWidth', 0.02, 0.8], ['threshold', 0.75, 0.99], ['opacity', 0.05, 1], ['padding', 0, 12]]) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`水印参数 ${key} 超出允许范围。`);
  }
  if (!Number.isInteger(settings.padding)) throw new Error('掩膜扩展必须为整数。');
}

export async function validateWatermarkTemplate(input) {
  const { data, info } = await decode(input, true);
  let weight = 0;
  for (let p = 3; p < data.length; p += 4) weight += data[p] / 255;
  if (info.width < 12 || info.height < 6 || weight < 30 || weight > info.width * info.height * 0.9) throw new Error('模板需要透明背景和清晰的文字笔画，不能上传整张截图。');
}

function responsePlane(data, color) {
  const out = new Float32Array(data.length / 4);
  // Project chroma onto the template color; yellow is separated from white/black text.
  const avg = (color[0] + color[1] + color[2]) / 3;
  const c = color.map(v => v - avg), length = Math.hypot(...c);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = length > 20 ? (data[p] * c[0] + data[p + 1] * c[1] + data[p + 2] * c[2]) / length : (data[p] + data[p + 1] + data[p + 2]) / 3;
  }
  return out;
}

function samplesFor(data, width, height) {
  const samples = [];
  const step = Math.max(1, Math.ceil(Math.sqrt(width * height / 450)));
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) samples.push({ x, y, t: data[(y * width + x) * 4 + 3] / 255 });
  const mean = samples.reduce((s, p) => s + p.t, 0) / samples.length;
  let variance = 0;
  for (const p of samples) { p.t -= mean; variance += p.t * p.t; }
  return { samples, variance };
}

function correlation(plane, stride, x, y, model) {
  let sum = 0, squared = 0, dot = 0;
  for (const p of model.samples) {
    const v = plane[(y + p.y) * stride + x + p.x];
    sum += v; squared += v * v; dot += p.t * v;
  }
  const variance = squared - sum * sum / model.samples.length;
  return variance > 1 && model.variance > 1 ? Math.abs(dot) / Math.sqrt(variance * model.variance) : 0;
}

async function locate(data, info, template, ti, settings) {
  const ratio = Math.min(1, 640 / Math.max(info.width, info.height));
  const sw = Math.round(info.width * ratio), sh = Math.round(info.height * ratio);
  const small = await sharp(data, { raw: info }).resize(sw, sh).raw().toBuffer();
  const color = [0, 0, 0]; let weight = 0;
  for (let p = 0; p < template.length; p += 4) {
    const a = template[p + 3] / 255;
    weight += a;
    for (let c = 0; c < 3; c++) color[c] += template[p + c] * a;
  }
  if (weight < 30 || weight > ti.width * ti.height * 0.9) throw new Error('模板需要透明背景和清晰的文字笔画，不能上传整张截图。');
  const plane = responsePlane(small, color.map(v => v / weight));
  const peaks = [];
  for (const scale of [0.85, 0.925, 1, 1.075, 1.15]) {
    const width = Math.round(sw * settings.relativeWidth * scale);
    const height = Math.round(width * ti.height / ti.width);
    if (width < 12 || height < 6 || width > sw || height > sh) continue;
    const resized = await sharp(template, { raw: ti }).resize(width, height).raw().toBuffer();
    const model = samplesFor(resized, width, height);
    const minX = settings.search === 'bottom-right' ? Math.floor(sw * 0.4) : 0;
    const minY = settings.search === 'bottom-right' ? Math.floor(sh * 0.6) : 0;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 16));
    const coarse = [];
    for (let y = minY; y <= sh - height; y += step) for (let x = minX; x <= sw - width; x += step) {
      const score = correlation(plane, sw, x, y, model);
      if (coarse.length < 8 || score > coarse.at(-1).score) {
        coarse.push({ x, y, score }); coarse.sort((a, b) => b.score - a.score); coarse.length = Math.min(coarse.length, 8);
      }
    }
    for (const peak of coarse) {
      let best = peak;
      for (let y = Math.max(minY, peak.y - step); y <= Math.min(sh - height, peak.y + step); y++) for (let x = Math.max(minX, peak.x - step); x <= Math.min(sw - width, peak.x + step); x++) {
        const score = correlation(plane, sw, x, y, model);
        if (score > best.score) best = { x, y, score };
      }
      peaks.push({ ...best, width, height });
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const best = peaks[0];
  if (!best || best.score < settings.threshold) return { status: 'skipped', confidence: best?.score || 0, reason: '未匹配到高置信度水印，原图保留。' };
  const other = peaks.find(p => Math.abs(p.x - best.x) > best.width / 2 || Math.abs(p.y - best.y) > best.height / 2);
  if (other && other.score > best.score - 0.025) return { status: 'skipped', confidence: best.score, reason: '存在多个相似区域，无法可靠定位，请缩小搜索范围或换模板。' };
  // Refine translation at original resolution to avoid applying a shifted glyph mask.
  const width = Math.round(best.width / ratio), height = Math.round(best.height / ratio);
  const resized = await sharp(template, { raw: ti }).resize(width, height).raw().toBuffer();
  const model = samplesFor(resized, width, height);
  const fullPlane = responsePlane(data, color.map(v => v / weight));
  let refined = { x: Math.round(best.x / ratio), y: Math.round(best.y / ratio), score: -1 };
  const radius = Math.ceil(2 / ratio);
  const cx = refined.x, cy = refined.y;
  for (let y = Math.max(0, cy - radius); y <= Math.min(info.height - height, cy + radius); y++) for (let x = Math.max(0, cx - radius); x <= Math.min(info.width - width, cx + radius); x++) {
    const score = correlation(fullPlane, info.width, x, y, model);
    if (score > refined.score) refined = { x, y, score };
  }
  if (refined.score < settings.threshold) return { status: 'skipped', confidence: refined.score, reason: '原始分辨率校验未通过，原图保留。' };
  return { status: 'matched', ...refined, width, height, template: resized };
}

// Boundary propagation with harmonic relaxation: a lightweight CPU inpainting
// fallback, not Telea and not a reconstruction of the occluded original text.
export function inpaintPixels(data, width, height, mask) {
  const known = Uint8Array.from(mask, v => v ? 0 : 1), queue = [];
  const neighbors = p => [p % width ? p - 1 : -1, p % width < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p < width * (height - 1) ? p + width : -1].filter(n => n >= 0);
  for (let p = 0; p < mask.length; p++) if (mask[p] && neighbors(p).some(n => known[n])) { queue.push(p); known[p] = 2; }
  for (let index = 0; index < queue.length; index++) {
    const p = queue[index], surrounding = neighbors(p).filter(n => known[n] === 1);
    if (!surrounding.length) continue;
    for (let c = 0; c < 3; c++) data[p * 4 + c] = Math.round(surrounding.reduce((s, n) => s + data[n * 4 + c], 0) / surrounding.length);
    known[p] = 1;
    for (const n of neighbors(p)) if (!known[n]) { known[n] = 2; queue.push(n); }
  }
  for (let iteration = 0; iteration < 24; iteration++) for (const p of queue) {
    const surrounding = neighbors(p);
    for (let c = 0; c < 3; c++) data[p * 4 + c] = Math.round(surrounding.reduce((s, n) => s + data[n * 4 + c], 0) / surrounding.length);
  }
}

export async function removeKnownWatermark(input, templateInput, settings) {
  validateSettings(settings);
  const { data, info } = await decode(input);
  const { data: template, info: ti } = await decode(templateInput, true);
  const match = await locate(data, info, template, ti, settings);
  if (match.status !== 'matched') return match;
  const { x, y, width, height } = match;
  const pad = settings.padding;
  const left = Math.max(0, x - pad), top = Math.max(0, y - pad);
  const rw = Math.min(info.width - left, width + 2 * pad), rh = Math.min(info.height - top, height + 2 * pad);
  const roi = await sharp(data, { raw: info }).extract({ left, top, width: rw, height: rh }).raw().toBuffer();
  const mask = new Uint8Array(rw * rh);
  let repaired = 0;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const t = (j * width + i) * 4, alpha = match.template[t + 3] / 255;
    if (alpha < 0.08) continue;
    const p = (y - top + j) * rw + x - left + i;
    const a = alpha * settings.opacity;
    let needsRepair = settings.mode === 'inpaint' || a >= 0.9;
    if (!needsRepair) {
      const values = [0, 1, 2].map(c => (roi[p * 4 + c] - a * match.template[t + c]) / (1 - a));
      if (values.some(v => v < -12 || v > 267)) needsRepair = true;
      else for (let c = 0; c < 3; c++) roi[p * 4 + c] = Math.round(Math.max(0, Math.min(255, values[c])));
    }
    if (needsRepair) {
      repaired++;
      for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) {
        const mx = p % rw + dx, my = Math.floor(p / rw) + dy;
        if (mx >= 0 && my >= 0 && mx < rw && my < rh) mask[my * rw + mx] = 1;
      }
    }
  }
  inpaintPixels(roi, rw, rh, mask);
  for (let j = 0; j < rh; j++) roi.copy(data, ((top + j) * info.width + left) * 4, j * rw * 4, (j + 1) * rw * 4);
  const bytes = await sharp(data, { raw: info }).png().toBuffer();
  if (bytes.length > 8 * 1024 * 1024) throw new Error('处理结果超过 8 MB，请先缩小原图后重试。');
  return { status: 'processed', bytes, confidence: match.score, region: { x, y, width, height }, repairedPixels: repaired, reason: repaired ? '已进行局部推测修补，遮挡的文字和细节不能保证还原，请检查预览。' : '已按设定透明度反向混合，请检查边缘和残影。' };
}

// Brand only successfully repaired images. Detection failures must keep the
// original intact rather than disguising an unremoved mark with a new logo.
export async function removeAndBrandWatermark(input, templateInput, settings) {
  const result = await removeKnownWatermark(input, templateInput, settings);
  if (result.status !== 'processed') return result;
  const { data, info } = await decode(result.bytes);
  const shorter = Math.min(info.width, info.height);
  const margin = Math.max(2, Math.min(Math.max(8, Math.round(shorter * 0.025)), Math.floor(shorter / 5)));
  const fontSize = Math.max(12, shorter * 0.045);
  const scale = Math.min(fontSize / 100, (info.width - 2 * margin) / 230, (info.height - 2 * margin) / 110);
  const width = Math.max(1, Math.round(230 * scale)), height = Math.max(1, Math.round(110 * scale));
  const left = info.width - margin - width, top = info.height - margin - height;
  const overlay = await sharp(Buffer.from(SHENXIANG_WATERMARK_SVG)).resize(width, height).png().toBuffer();
  const roi = await sharp(data, { raw: info }).extract({ left, top, width, height }).composite([{ input: overlay }]).raw().toBuffer();
  // Copy only the branded rectangle so all other pixels remain byte-identical
  // to the repair stage, including their alpha channel.
  for (let j = 0; j < height; j++) roi.copy(data, ((top + j) * info.width + left) * 4, j * width * 4, (j + 1) * width * 4);
  const bytes = await sharp(data, { raw: info }).png().toBuffer();
  if (bytes.length > 8 * 1024 * 1024) throw new Error('添加深巷水印后的结果超过 8 MB，请先缩小原图后重试。');
  return {
    ...result, bytes,
    platformWatermark: { text: '深巷', opacity: 179, transparencyPercent: 30, style: 'plain', position: 'bottom-right', region: { x: left, y: top, width, height } },
    reason: `${result.reason}已添加右下角“深巷”水印（透明度 30%）。`,
  };
}
