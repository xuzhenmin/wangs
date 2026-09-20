import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const articleId = "11111111-1111-4111-8111-111111111111";
const code = "abcdefghijklmnopqrstuvwxyz012345";
const rotatedCode = `${code.slice(0, -3)}new`;
const origin = "https://news.example.com";
const validShare = () => ({ code, sharePath: `/articles/${articleId}#video-access=${code}`, createdAt: 1000, revokedAt: null });
const flush = () => new Promise(resolve => setImmediate(resolve));
const jsx = (type, props) => ({ type, props: props || {} });
const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : String(node ?? "");

function compile(hooks = {}, globals = {}) {
  const source = readFileSync(new URL("../app/ops-7q4m/articles/ArticleVideoShare.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const imports = { react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx }, "./ArticleVideoShare.module.css": { default: new Proxy({}, { get: (_target, key) => key }) } };
  const loaded = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${outputText}\n})`, { URL, AbortController, AbortSignal, Intl, ...globals })(name => {
    assert.ok(name in imports, `Unexpected import ${name}`); return imports[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

async function harness({ revoked = false, autoCopy = false, clipboardFails = false, unauthorized = false, delayed = false } = {}) {
  let cursor = 0, tree, closed = 0, authFailures = 0, confirm = false, pending;
  let share = revoked ? { ...validShare(), code: null, sharePath: null, revokedAt: 2000 } : validShare();
  const values = [], effects = [], requests = [], copied = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === "function" ? value(values[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return values[i] ||= { current: initial }; },
    useId() { return `share-${cursor++}`; },
    useCallback(callback, deps) { const i = cursor++; if (!values[i] || deps.some((dep, index) => dep !== values[i].deps[index])) values[i] = { callback, deps }; return values[i].callback; },
    useEffect(callback, deps) { const i = cursor++; if (!values[i] || deps.some((dep, index) => dep !== values[i].deps[index])) { const previous = values[i]; values[i] = { deps, cleanup: null }; effects.push(() => { previous?.cleanup?.(); values[i].cleanup = callback(); }); } },
  };
  const component = compile(hooks, {
    window: { location: { origin }, confirm: () => confirm },
    navigator: { clipboard: { writeText: async value => { if (clipboardFails) throw new Error("clipboard-denied"); copied.push(value); } } },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (delayed) await new Promise(resolve => { pending = resolve; });
      if (unauthorized) return { status: 401, ok: false, json: async () => ({ error: "admin-required" }) };
      if (options.method === "DELETE") share = { ...share, code: null, sharePath: null, revokedAt: 3000 };
      if (options.body && JSON.parse(options.body).action === "rotate") share = { ...validShare(), code: rotatedCode, sharePath: `/articles/${articleId}#video-access=${rotatedCode}`, createdAt: 3000 };
      return { status: 200, ok: true, json: async () => ({ hasPrivateVideos: true, share }) };
    },
  });
  const onClose = () => { closed++; }, onUnauthorized = () => { authFailures++; };
  async function render() {
    cursor = 0; tree = component.default({ articleId, title: "Synthetic private video article", copyOnLoad: autoCopy, onClose, onUnauthorized });
    tree.props.ref.current ||= { showModal() {}, close() {} };
    for (const effect of effects.splice(0)) effect();
    await flush();
  }
  const button = label => {
    const found = nodes(tree).find(node => node.type === "button" && text(node) === label);
    assert.ok(found, `Expected button ${label}`); return found;
  };
  const cleanup = () => { for (const value of values) value?.cleanup?.(); };
  await render(); await render();
  return {
    requests, copied, button, render, cleanup, nodes: () => nodes(tree), text: () => text(tree), closed: () => closed, unauthorized: () => authFailures,
    setConfirm(value) { confirm = value; }, resolve: () => pending?.(), async click(label) { button(label).props.onClick(); await flush(); await render(); },
    cancel() { tree.props.onCancel({ preventDefault() {} }); },
  };
}

test("share links accept only this article on this origin with a fragment secret", () => {
  const { articleVideoShareUrl } = compile();
  assert.equal(articleVideoShareUrl(articleId, validShare(), origin), `${origin}${validShare().sharePath}`);
  for (const sharePath of [`https://other.example.com${validShare().sharePath}`, `/articles/other#video-access=${code}`, `/articles/${articleId}?code=${code}#video-access=${code}`, `/articles/${articleId}#video-access=other`, `https://user:password@news.example.com${validShare().sharePath}`]) {
    assert.equal(articleVideoShareUrl(articleId, { ...validShare(), sharePath }, origin), null);
  }
  assert.equal(articleVideoShareUrl(articleId, { ...validShare(), revokedAt: 1000 }, origin), null);
  assert.equal(articleVideoShareUrl(articleId, { ...validShare(), code: `${code}a`, sharePath: `/articles/${articleId}#video-access=${code}a` }, origin), null);
});

test("opening requests ensure once, copies secrets only from readonly fields and no code is placed in notices", async () => {
  const h = await harness();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, `/api/admin/articles/${articleId}/video-share`);
  assert.deepEqual(JSON.parse(h.requests[0].body), { action: "ensure" });
  assert.equal(h.copied.length, 0);
  const fields = h.nodes().filter(node => node.type === "input");
  assert.equal(fields.length, 2); assert.ok(fields.every(field => field.props.readOnly));
  assert.equal(fields[0].props.value, code);
  await h.click("复制分享链接");
  assert.deepEqual(h.copied, [`${origin}${validShare().sharePath}`]);
  assert.doesNotMatch(h.text(), new RegExp(code));
  h.cancel(); await h.render();
  assert.equal(h.closed(), 1); assert.equal(h.nodes().filter(node => node.type === "input").length, 0);
  assert.equal(h.requests[0].signal.aborted, true);
  h.cleanup();
});

test("list copy action has manual readonly fallback when clipboard permission is denied", async () => {
  const h = await harness({ autoCopy: true, clipboardFails: true });
  assert.match(h.text(), /手动复制/);
  assert.equal(h.nodes().filter(node => node.type === "input").length, 2);
  assert.equal(h.copied.length, 0); h.cleanup();
});

test("revoked ensure stays revoked and only a confirmed explicit rotate restores sharing", async () => {
  const h = await harness({ revoked: true });
  assert.match(h.text(), /已停用/);
  assert.equal(h.nodes().filter(node => node.type === "input").length, 0);
  await h.click("重置访问码"); assert.equal(h.requests.length, 1);
  h.setConfirm(true); await h.click("重置访问码");
  assert.deepEqual(JSON.parse(h.requests[1].body), { action: "rotate" });
  assert.equal(h.nodes().filter(node => node.type === "input")[0].props.value, rotatedCode);
  await h.click("停用分享");
  assert.equal(h.requests[2].method, "DELETE");
  assert.equal(h.nodes().filter(node => node.type === "input").length, 0);
  assert.match(h.text(), /已停用/); h.cleanup();
});

test("401 clears authorization through the parent and stale results after close cannot copy or display secrets", async () => {
  const unauthorized = await harness({ unauthorized: true });
  assert.equal(unauthorized.unauthorized(), 1);
  assert.equal(unauthorized.nodes().filter(node => node.type === "input").length, 0); unauthorized.cleanup();
  const delayed = await harness({ delayed: true, autoCopy: true });
  delayed.cancel(); delayed.resolve(); await flush(); await delayed.render();
  assert.equal(delayed.copied.length, 0);
  assert.equal(delayed.nodes().filter(node => node.type === "input").length, 0); delayed.cleanup();
});
