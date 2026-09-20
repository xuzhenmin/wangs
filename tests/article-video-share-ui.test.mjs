import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadTs } from './helpers/load-typescript.mjs';

const helper = loadTs('../lib/article-video-share-link.ts', import.meta.url);
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const token = 'A_0123456789abcdefghijklmnopqrs-', second = 'B_0123456789abcdefghijklmnopqrs-';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('share fragment parser accepts only one exact named 32-character bearer and never decodes arbitrary fragments', () => {
  assert.deepEqual(helper.parseArticleVideoShareFragment(`#video-access=${token}`), { present: true, code: token });
  for (const hash of ['#video-access=', '#video-access', `#video-access=${token}&video-access=${second}`, `#video-access=${token}&utm=x`, '#video-access=%41'.repeat(32), `#other=x&video-access=${token}`, `#video-access=${token}x`]) {
    assert.deepEqual(helper.parseArticleVideoShareFragment(hash), { present: true, code: null }, hash);
  }
  for (const hash of ['', '#chapter-1', '#unknown=secret', null, undefined]) assert.deepEqual(helper.parseArticleVideoShareFragment(hash), { present: false, code: null });
  assert.equal(helper.articleIdFromPath(`/articles/${id}`), id);
  assert.equal(helper.articleIdFromPath(`/articles/${id}/`), id);
  for (const pathname of ['/', `/articles/${id}/edit`, `/articles/${id}?x=1`, '/articles/../../private', null]) assert.equal(helper.articleIdFromPath(pathname), null);
});

test('sharing preserves only a same-origin same-article token; metadata canonical URL remains clean', () => {
  const current = `https://news.example.com/articles/${id}?from=chat#video-access=${token}`;
  assert.equal(helper.articleVideoShareLink(`/articles/${id}`, current), `https://news.example.com/articles/${id}#video-access=${token}`);
  assert.equal(helper.articleVideoShareLink(`/articles/${other}`, current), `https://news.example.com/articles/${other}`);
  assert.equal(helper.articleVideoShareLink(`https://foreign.example/articles/${id}`, current), `https://foreign.example/articles/${id}`);
  assert.equal(helper.articleVideoShareLink(`https://news.example.com/articles/${id}`, `http://localhost:3217/articles/${id}#video-access=${token}`), `https://news.example.com/articles/${id}`);
  assert.equal(helper.articleVideoShareLink(`/articles/${id}#untrusted`, current.replace(token, 'invalid')), `https://news.example.com/articles/${id}`);
  assert.equal(helper.articleVideoShareLink('/', `https://news.example.com/#video-access=${token}`), 'https://news.example.com/');
  const page = readFileSync(new URL('../app/articles/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /<ArticleVideoShareAccess[^>]*articleId=\{article\.id\}/);
  assert.ok(page.indexOf('<ArticleVideoShareAccess') < page.indexOf('<ArticleAccessGate'), 'auto-exchange runs outside article/location disclosure');
  assert.doesNotMatch(page.slice(page.indexOf('generateMetadata'), page.indexOf('export default')), /video-access|ShareAccess|window\.location/);
});

async function accessHarness({ hash = '', articleId = id, initialResponse } = {}) {
  let cursor = 0, currentArticle = articleId, tree, cookieJar = '';
  const values = [], effects = [], requests = [], events = [], listeners = new Map();
  const location = new URL(`https://news.example.com/articles/${articleId}${hash}`);
  const jsx = (type, props) => ({ type, props: props || {} });
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], update => { values[index] = typeof update === 'function' ? update(values[index]) : update; }]; },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!values[index] || deps.some((dep, i) => values[index].deps[i] !== dep)) {
        const old = values[index]; values[index] = { deps, callback, cleanup: null };
        effects.push(() => { old?.cleanup?.(); values[index].cleanup = callback(); });
      }
    },
  };
  const source = readFileSync(new URL('../app/articles/[id]/ArticleVideoShareAccess.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loadedModule = { exports: {} };
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../../lib/article-video-share-link': helper,
    '../../../lib/private-video-reference': { isPrivateVideoId: value => helper.articleIdFromPath(`/articles/${value}`) === value },
    './ArticleVideoShareAccess.module.css': { default: { notice: 'notice' } },
  };
  vm.runInNewContext(`(function(require,module,exports){${output}\n})`, {
    AbortSignal, Event,
    window: { location, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), dispatchEvent: event => events.push(event.type) },
    fetch: (url, options) => {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ url, options, resolve, reject, cookieAtStart: cookieJar });
      if (initialResponse) resolve(initialResponse());
      return promise;
    },
  })(name => { if (!(name in imports)) throw new Error(`Unexpected import ${name}`); return imports[name]; }, loadedModule, loadedModule.exports);
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const text = node => !node || typeof node !== 'object' ? String(node ?? '') : Array.isArray(node) ? node.map(text).join('') : text(node.props.children);
  const render = async () => {
    cursor = 0; tree = loadedModule.exports.default({ articleId: currentArticle });
    for (const effect of effects.splice(0)) effect();
    await flush();
  };
  await render(); await render();
  return {
    requests, events, location, render, text: () => text(tree), tree: () => tree,
    async strictRemount() { for (const value of values) if (value?.callback) { value.cleanup?.(); value.cleanup = value.callback(); } await flush(); await render(); },
    async respond(index, body, status = 200, sessionCookie) { if (sessionCookie !== undefined) cookieJar = sessionCookie; requests[index].resolve(Response.json(body, { status })); await flush(); await render(); },
    async fail(index) { requests[index].reject(new Error('private upstream token must not appear')); await flush(); await render(); },
    async hashChange(hash) { location.hash = hash; listeners.get('hashchange')?.(); await flush(); await render(); },
    async navigate(nextId, hash) { location.pathname = `/articles/${nextId}`; location.hash = hash; currentArticle = nextId; await render(); await render(); },
    async retry() { nodes(tree).find(node => node.type === 'button').props.onClick(); await render(); await render(); },
    cleanup() { for (const value of values) value?.cleanup?.(); },
  };
}

test('auto-unlock POST is StrictMode-deduplicated, credential stays in fragment/body, and success notifies mounted players', async () => {
  const h = await accessHarness({ hash: `#video-access=${token}` });
  assert.equal(h.requests.length, 1); assert.match(h.text(), /正在验证/);
  await h.strictRemount(); assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, `/api/articles/${id}/video-access`); assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store');
  assert.equal(JSON.parse(request.options.body).code, token); assert.ok(!request.url.includes(token));
  await h.respond(0, { authorized: true });
  assert.equal(h.tree(), null); assert.deepEqual(h.events, ['private-video-access-changed']);
  assert.equal(h.location.hash, `#video-access=${token}`);
  await h.hashChange(`#video-access=${token}`); assert.equal(h.requests.length, 1);
  h.cleanup();
});

test('missing or malformed share fragment never authorizes; failed validation stays visible and can retry', async () => {
  const missing = await accessHarness(); assert.equal(missing.requests.length, 0); assert.equal(missing.tree(), null); missing.cleanup();
  const malformed = await accessHarness({ hash: '#video-access=wrong' });
  assert.equal(malformed.requests.length, 0); assert.equal(malformed.tree().props.role, 'alert'); assert.match(malformed.text(), /格式不正确/); assert.equal(malformed.events.length, 0); malformed.cleanup();
  const invalid = await accessHarness({ hash: `#video-access=${token}` });
  await invalid.respond(0, { error: `Do not reflect ${token}` }, 401);
  assert.match(invalid.text(), /已失效/); assert.ok(!invalid.text().includes(token)); assert.equal(invalid.events.length, 0);
  await invalid.retry(); assert.equal(invalid.requests.length, 2);
  await invalid.respond(1, { authorized: true }); assert.equal(invalid.events.length, 1); invalid.cleanup();
});

test('hash and article navigation discard stale success; network/rate-limit errors support safe retry', async () => {
  const h = await accessHarness({ hash: `#video-access=${token}` });
  await h.hashChange(`#video-access=${second}`); assert.equal(h.requests.length, 1, 'next exchange waits for the first session cookie');
  await h.respond(0, { authorized: true }); assert.equal(h.requests.length, 2); assert.equal(h.events.length, 0); assert.match(h.text(), /正在验证/);
  await h.fail(1); assert.match(h.text(), /暂时无法验证/); assert.ok(!h.text().includes('upstream'));
  await h.retry(); assert.equal(h.requests.length, 3);
  await h.navigate(other, `#video-access=${token}`); assert.equal(h.requests.length, 3);
  await h.respond(2, { authorized: true }); assert.equal(h.events.length, 0); assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].url, `/api/articles/${other}/video-access`);
  await h.respond(3, { error: 'slow down' }, 429); assert.match(h.text(), /过于频繁/);
  await h.hashChange('#chapter-2'); assert.equal(h.tree(), null); h.cleanup();
});

test('rapid anonymous navigation serializes exchanges so the current article reuses the first HttpOnly session', async () => {
  const h = await accessHarness({ hash: `#video-access=${token}` });
  assert.equal(h.requests[0].cookieAtStart, '');
  await h.navigate(other, `#video-access=${second}`);
  assert.equal(h.requests.length, 1);
  await h.respond(0, { authorized: true }, 200, 'synthetic-browser-session');
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].cookieAtStart, 'synthetic-browser-session');
  assert.equal(h.requests[1].url, `/api/articles/${other}/video-access`);
  assert.equal(h.events.length, 0, 'previous article completion never advertises current authorization');
  await h.respond(1, { authorized: true }, 200, 'synthetic-browser-session');
  assert.equal(h.events.length, 1); assert.equal(h.tree(), null); h.cleanup();
});
