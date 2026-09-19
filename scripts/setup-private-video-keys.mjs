#!/usr/bin/env node
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Run explicitly on EACH deployment. Never copy a deployment's private keys to
// another server or regenerate existing keys: doing so makes old assets unreadable.
const filename = path.resolve(process.argv[2] || '.env.local');
try {
  let existing = '';
  try { existing = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const configured = name => {
    const matches = [...existing.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*([^\\r\\n]*)`, 'gm'))];
    if (matches.length > 1) throw new Error('Duplicate configuration');
    return matches[0]?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || '';
  };
  const additions = new Map();
  if (!configured('PRIVATE_VIDEO_MASTER_KEY')) additions.set('PRIVATE_VIDEO_MASTER_KEY', randomBytes(32).toString('base64'));
  if (!configured('PRIVATE_VIDEO_SYNC_PRIVATE_KEY')) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    additions.set('PRIVATE_VIDEO_SYNC_PRIVATE_KEY', Buffer.from(privateKey).toString('base64'));
  }
  if (!configured('PRIVATE_VIDEO_UPLOAD_ENABLED')) additions.set('PRIVATE_VIDEO_UPLOAD_ENABLED', 'false');
  if (additions.size) {
    // Replace only absent/empty entries. Existing non-empty secrets are retained.
    let result = existing;
    for (const [name, value] of additions) {
      const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[^\\r\\n]*`, 'm');
      result = pattern.test(result) ? result.replace(pattern, `${name}=${value}`) : `${result}\n${name}=${value}\n`;
    }
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.write(result); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
    console.log('私密视频配置已补充，密钥未输出。请安全备份环境文件。');
  } else console.log('配置项已存在，未覆盖或轮换任何密钥。');
  console.log('核对 OSS 私有目录、读取权限和 CORS 后，将 PRIVATE_VIDEO_UPLOAD_ENABLED 改为 true 并重启服务。');
} catch {
  console.error('配置文件处理失败，请检查路径和文件权限。未输出任何密钥；重试前请检查文件是否已写入。');
  process.exitCode = 1;
}
