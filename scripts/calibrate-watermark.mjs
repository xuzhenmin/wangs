// Offline calibration only: generates a template and review image, never edits articles.
// Usage: node scripts/calibrate-watermark.mjs INPUT OUTPUT_DIRECTORY --authorized
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createYellowTemplate, removeKnownWatermark } from './watermark-engine.mjs';

const [input, output, authorized] = process.argv.slice(2);
if (!input || !output || authorized !== '--authorized') throw new Error('需要指定样图、输出目录和 --authorized。');
const bytes = await readFile(path.resolve(input));
const settings = await createYellowTemplate(bytes, [0.57, 0.83, 0.42, 0.16]);
const result = await removeKnownWatermark(bytes, Buffer.from(settings.template, 'base64'), settings);
await mkdir(path.resolve(output), { recursive: true });
await writeFile(path.join(output, 'default.json'), JSON.stringify(settings), { mode: 0o600 });
await writeFile(path.join(output, 'template.png'), Buffer.from(settings.template, 'base64'));
if (result.bytes) await writeFile(path.join(output, 'review.png'), result.bytes);
console.log(JSON.stringify({ status: result.status, confidence: result.confidence, reason: result.reason, output: path.resolve(output) }));
