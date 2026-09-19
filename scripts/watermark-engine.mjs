import sharp from 'sharp';
import { SHENXIANG_WATERMARK_SVG } from './shenxiang-watermark.mjs';

export const MAX_WATERMARK_INPUT_PIXELS = 40_000_000;
const TEMPLATE_PIXELS = 1_000_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

async function openImage(input, template = false) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > (template ? 1024 * 1024 : 8 * 1024 * 1024)) throw new Error('图片为空或超过大小限制。');
  const image = sharp(bytes, { limitInputPixels: template ? TEMPLATE_PIXELS : MAX_WATERMARK_INPUT_PIXELS });
  let meta;
  try { meta = await image.metadata(); }
  catch (error) {
    if (/exceeds pixel limit/i.test(error.message)) throw new Error(template
      ? '模板超过 100 万像素，请缩小透明 PNG 模板后重试。'
      : '原图超过 4000 万像素，请等比例缩小原图后重新导入。');
    throw error;
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) > 1) throw new Error('仅处理静态 PNG、JPEG、WebP，不支持动画或 SVG。');
  // The editor's percentage selection uses the EXIF-oriented display dimensions.
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  return { image: image.rotate(), width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
}

async function decode(input, template = false) {
  const { image } = await openImage(input, template);
  return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

const isYellow = (r, g, b) => r > 160 && g > 90 && g < r * 0.94 && b < g * 0.65 && r - b > 85;

function validateOutlineRadius(radius) {
  if (!Number.isInteger(radius) || radius < 1 || radius > 12) throw new Error('描边检测范围必须为 1 至 12 的整数像素。');
}

// Bounded Chebyshev distance to yellow strokes, not a flood fill through dark
// backgrounds. Work only on the <= 1 MP calibration crop and preserve its RGB.
function includeNearbyDarkOutline(data, rgba, width, height, radius) {
  const distance = new Uint8Array(width * height).fill(radius + 1);
  for (let i = 0; i < distance.length; i++) if (rgba[i * 4 + 3]) distance[i] = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    let d = distance[i];
    if (x) d = Math.min(d, distance[i - 1] + 1);
    if (y) {
      d = Math.min(d, distance[i - width] + 1);
      if (x) d = Math.min(d, distance[i - width - 1] + 1);
      if (x + 1 < width) d = Math.min(d, distance[i - width + 1] + 1);
    }
    distance[i] = d;
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    let d = distance[i];
    if (x + 1 < width) d = Math.min(d, distance[i + 1] + 1);
    if (y + 1 < height) {
      d = Math.min(d, distance[i + width] + 1);
      if (x) d = Math.min(d, distance[i + width - 1] + 1);
      if (x + 1 < width) d = Math.min(d, distance[i + width + 1] + 1);
    }
    distance[i] = d;
  }
  let count = 0;
  for (let i = 0; i < distance.length; i++) {
    if (!distance[i] || distance[i] > radius) continue;
    const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
    if (data[p + 3] < 128 || Math.max(r, g, b) > 120 || Math.max(r, g, b) - Math.min(r, g, b) > 60) continue;
    rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
    count++;
  }
  return count;
}

// Black-only extraction stays conservative. Outlined yellow templates retain
// nearby dark pixels for repair, but matching uses only the yellow strokes.
export async function createColorTemplate(input, region, color = 'yellow', outlineRadius = 4) {
  if (!['yellow', 'black', 'yellow-outline'].includes(color)) throw new Error('提取颜色无效，请选择黄色、黑色或黄色＋黑色描边。');
  validateOutlineRadius(outlineRadius);
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) throw new Error('模板区域不合法。');
  const [rx, ry, rw, rh] = region;
  if (region.length !== 4 || !region.every(Number.isFinite) || rx < 0 || ry < 0 || rw <= 0 || rh <= 0 || rx + rw > 1.001 || ry + rh > 1.001) throw new Error('模板区域不合法。');
  const source = await openImage(input);
  const x = Math.round(rx * source.width), y = Math.round(ry * source.height);
  const cropWidth = Math.min(Math.round(rw * source.width), source.width - x);
  const cropHeight = Math.min(Math.round(rh * source.height), source.height - y);
  if (cropWidth < 16 || cropHeight < 8) throw new Error('模板区域过小，请扩大选区。');
  const ratio = Math.min(1, Math.sqrt(TEMPLATE_PIXELS / (cropWidth * cropHeight)));
  const width = Math.floor(cropWidth * ratio), height = Math.floor(cropHeight * ratio);
  if (width < 16 || height < 8) throw new Error('模板选区过于狭长，请缩小范围并紧贴水印。');
  // Crop in libvips before exposing pixels to JS. Only the template working copy
  // is reduced if necessary; never resize or overwrite the article's raw image.
  const image = source.image.extract({ left: x, top: y, width: cropWidth, height: cropHeight });
  if (ratio < 1) image.resize(width, height, { fit: 'fill' });
  const data = await image.ensureAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  let count = 0;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const p = (j * width + i) * 4, q = p;
    const [r, g, b] = data.subarray(p, p + 3);
    const matches = color !== 'black'
      ? isYellow(r, g, b) && (color !== 'yellow-outline' || data[p + 3] >= 128)
      : Math.max(r, g, b) <= 95 && Math.max(r, g, b) - Math.min(r, g, b) <= 35 && data[p + 3] >= 128;
    if (matches) {
      rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b; rgba[q + 3] = 255; count++;
    }
  }
  if (count < 80 || count / (width * height) > 0.8) throw new Error(`没有提取到可靠的${color === 'black' ? '黑色' : '黄色'}文字，请调整框选区域，避开同色背景。`);
  if (color === 'yellow-outline') {
    count += includeNearbyDarkOutline(data, rgba, width, height, Math.max(1, Math.round(outlineRadius * ratio)));
    if (count / (width * height) > 0.8) throw new Error('描边与背景难以区分，请减小描边检测范围或换一张背景更清晰的样图。');
  }
  const template = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return {
    template: template.toString('base64'), extractionColor: color, relativeWidth: cropWidth / source.width,
    mode: 'inpaint', search: color === 'yellow-outline' ? 'bottom' : 'bottom-right', threshold: 0.86, opacity: 0.7,
    padding: color === 'yellow-outline' ? 1 : 6,
    ...(color === 'yellow-outline' ? { outlineRadius } : {}),
  };
}

// Preserve the existing offline calibration entry point.
export const createYellowTemplate = (input, region) => createColorTemplate(input, region, 'yellow');

export function validateSettings(settings) {
  if (!settings || !['inpaint', 'inverse'].includes(settings.mode) || !['bottom-right', 'bottom', 'all'].includes(settings.search)) throw new Error('水印处理模式无效。');
  if (settings.allowLossyOutput !== undefined && typeof settings.allowLossyOutput !== 'boolean') throw new Error('大图压缩选项无效。');
  if (settings.extractionColor !== undefined && !['yellow', 'black', 'yellow-outline'].includes(settings.extractionColor)) throw new Error('提取颜色无效，请选择黄色、黑色或黄色＋黑色描边。');
  if (settings.outlineRadius !== undefined) validateOutlineRadius(settings.outlineRadius);
  if (settings.extractionColor === 'yellow-outline' && settings.mode !== 'inpaint') throw new Error('黄色＋黑色描边模板仅支持笔画掩膜修补，不支持半透明反向混合。');
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

function responsePlane(data, color, area = null) {
  const out = new Float32Array(area ? area.width * area.height : data.length / 4);
  // Project chroma onto the template color; yellow is separated from white/black text.
  const avg = (color[0] + color[1] + color[2]) / 3;
  const c = color.map(v => v - avg), length = Math.hypot(...c);
  for (let i = 0; i < out.length; i++) {
    const p = area
      ? ((area.top + Math.floor(i / area.width)) * area.stride + area.left + i % area.width) * 4
      : i * 4;
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
  const matchTemplate = settings.extractionColor === 'yellow-outline' ? Buffer.from(template) : template;
  if (settings.extractionColor === 'yellow-outline') {
    for (let p = 0; p < matchTemplate.length; p += 4) {
      if (!isYellow(matchTemplate[p], matchTemplate[p + 1], matchTemplate[p + 2])) matchTemplate[p + 3] = 0;
    }
  }
  const color = [0, 0, 0]; let weight = 0;
  for (let p = 0; p < matchTemplate.length; p += 4) {
    const a = matchTemplate[p + 3] / 255;
    weight += a;
    for (let c = 0; c < 3; c++) color[c] += matchTemplate[p + c] * a;
  }
  if (weight < 30 || weight > ti.width * ti.height * 0.9) throw new Error('模板需要透明背景和清晰的文字笔画，不能上传整张截图。');
  const plane = responsePlane(small, color.map(v => v / weight));
  const peaks = [];
  for (const scale of [0.85, 0.925, 1, 1.075, 1.15]) {
    const width = Math.round(sw * settings.relativeWidth * scale);
    const height = Math.round(width * ti.height / ti.width);
    if (width < 12 || height < 6 || width > sw || height > sh) continue;
    const resized = await sharp(matchTemplate, { raw: ti }).resize(width, height).raw().toBuffer();
    const model = samplesFor(resized, width, height);
    const minX = settings.search === 'bottom-right' ? Math.floor(sw * 0.4) : 0;
    const minY = settings.search === 'all' ? 0 : Math.floor(sh * 0.6);
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
  const resized = await sharp(matchTemplate, { raw: ti }).resize(width, height).raw().toBuffer();
  const model = samplesFor(resized, width, height);
  let refined = { x: Math.round(best.x / ratio), y: Math.round(best.y / ratio), score: -1 };
  const radius = Math.ceil(2 / ratio);
  const cx = refined.x, cy = refined.y;
  const left = Math.max(0, cx - radius), top = Math.max(0, cy - radius);
  const right = Math.min(info.width - width, cx + radius), bottom = Math.min(info.height - height, cy + radius);
  if (right < left || bottom < top) return { status: 'skipped', confidence: best.score, reason: '水印区域超出图片边界，原图保留。' };
  const area = { left, top, width: right - left + width, height: bottom - top + height, stride: info.width };
  // Original-resolution verification needs only this neighbourhood, not a
  // second, full-image float buffer (160 MB at the maximum input size).
  const planeRegion = responsePlane(data, color.map(v => v / weight), area);
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const score = correlation(planeRegion, area.width, x - left, y - top, model);
    if (score > refined.score) refined = { x, y, score };
  }
  if (refined.score < settings.threshold) return { status: 'skipped', confidence: refined.score, reason: '原始分辨率校验未通过，原图保留。' };
  const repairTemplate = matchTemplate === template ? resized : await sharp(template, { raw: ti }).resize(width, height).raw().toBuffer();
  return { status: 'matched', ...refined, width, height, template: repairTemplate };
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

async function repairWatermarkPixels(input, templateInput, settings) {
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
  return { status: 'processed', data, info, confidence: match.score, region: { x, y, width, height }, repairedPixels: repaired, reason: repaired ? '已进行局部推测修补，遮挡的文字和细节不能保证还原，请检查预览。' : '已按设定透明度反向混合，请检查边缘和残影。' };
}

// Encode only the final pixels: an oversized intermediate PNG must not stop
// branding or cause a second lossy generation. Never reduce display dimensions.
export async function encodeWatermarkOutput(data, info, allowLossyOutput = false) {
  let bytes = await sharp(data, { raw: info }).png().toBuffer();
  const base = { width: info.width, height: info.height };
  if (bytes.length <= MAX_OUTPUT_BYTES) return { bytes, output: { ...base, format: 'png', byteLength: bytes.length, lossy: false } };
  if (!allowLossyOutput) throw new Error('处理结果超过 8 MB，请启用“超大结果压缩”后重试，或缩小原图后重新导入。');
  let transparent = false;
  for (let p = 3; p < data.length; p += 4) if (data[p] !== 255) { transparent = true; break; }
  const format = transparent ? 'webp' : 'jpeg';
  if ((transparent && (info.width > 16383 || info.height > 16383)) || info.width > 65500 || info.height > 65500) {
    throw new Error('图片边长超过压缩格式支持范围，请等比例缩小原图后重新导入。');
  }
  // Release the oversized encoded copy before each bounded compression attempt.
  bytes = null;
  for (const quality of [92, 86, 80]) {
    const image = sharp(data, { raw: info });
    bytes = await (transparent
      ? image.webp({ quality, alphaQuality: 100, effort: 3 })
      : image.jpeg({ quality, chromaSubsampling: '4:4:4' })).toBuffer();
    if (bytes.length <= MAX_OUTPUT_BYTES) return { bytes, output: { ...base, format, quality, byteLength: bytes.length, lossy: true } };
    bytes = null;
  }
  throw new Error('保持原尺寸压缩后仍超过 8 MB，已停止降低质量；请缩小原图后重新导入。');
}

function outputNotice(output) {
  return output.lossy ? `为满足 8 MB 限制，成品已采用 ${output.format === 'jpeg' ? 'JPEG' : 'WebP'} 有损压缩（质量参数 ${output.quality}），尺寸保持 ${output.width}×${output.height}，请检查细节。` : '';
}

export async function removeKnownWatermark(input, templateInput, settings) {
  const result = await repairWatermarkPixels(input, templateInput, settings);
  if (result.status !== 'processed') return result;
  const { data, info, ...report } = result;
  const encoded = await encodeWatermarkOutput(data, info, settings.allowLossyOutput === true);
  return { ...report, ...encoded, reason: report.reason + outputNotice(encoded.output) };
}

// Brand only successfully repaired images. Detection failures must keep the
// original intact rather than disguising an unremoved mark with a new logo.
export async function removeAndBrandWatermark(input, templateInput, settings) {
  const result = await repairWatermarkPixels(input, templateInput, settings);
  if (result.status !== 'processed') return result;
  const { data, info, ...report } = result;
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
  const encoded = await encodeWatermarkOutput(data, info, settings.allowLossyOutput === true);
  return {
    ...report, ...encoded,
    platformWatermark: { text: '深巷', opacity: 179, transparencyPercent: 30, style: 'plain', position: 'bottom-right', region: { x: left, y: top, width, height } },
    reason: `${report.reason}已添加右下角“深巷”水印（透明度 30%）。${outputNotice(encoded.output)}`,
  };
}
