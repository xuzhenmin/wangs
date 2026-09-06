import { parentPort, workerData } from 'node:worker_threads';
import { removeKnownWatermark } from './watermark-engine.mjs';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

try {
  parentPort.postMessage(await removeKnownWatermark(workerData.input, workerData.template, workerData.settings));
} catch (error) {
  parentPort.postMessage({ status: 'failed', reason: error.message || '图片处理失败。' });
}
