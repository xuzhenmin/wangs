import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';

test('key setup fills empty placeholders, preserves existing secrets and is idempotent without logging keys', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-video-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env.local');
  await writeFile(file, 'OTHER_SECRET=synthetic-retained-secret\nPRIVATE_VIDEO_MASTER_KEY=\nPRIVATE_VIDEO_SYNC_PRIVATE_KEY=""\n');
  const run = () => promisify(execFile)(process.execPath, ['scripts/setup-private-video-keys.mjs', file]);
  const output = await run();
  const result = await readFile(file, 'utf8');
  const value = name => result.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
  assert.equal(Buffer.from(value('PRIVATE_VIDEO_MASTER_KEY'), 'base64').length, 32);
  assert.equal(createPrivateKey(Buffer.from(value('PRIVATE_VIDEO_SYNC_PRIVATE_KEY'), 'base64')).asymmetricKeyType, 'rsa');
  assert.equal(value('PRIVATE_VIDEO_UPLOAD_ENABLED'), 'false');
  assert.match(result, /OTHER_SECRET=synthetic-retained-secret/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!output.stdout.includes(value('PRIVATE_VIDEO_MASTER_KEY')));
  assert.ok(!output.stdout.includes('synthetic-retained-secret'));
  await run();
  assert.equal(await readFile(file, 'utf8'), result);
});
