import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const base = "https://media.example.com/article-videos";
const id = "11111111-1111-4111-8111-111111111111";
const src = `${base}/${id}/video.mp4`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const privateReference = { isPrivateVideoId: value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), PRIVATE_VIDEO_ATTRIBUTE: "data-private-video-id" };

function compile(filename, imports, globals = {}) {
  const code = readFileSync(new URL(`../app/ops-7q4m/editor/${filename}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${outputText}\n})`, { URL, ...globals })(name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

function videoModule() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.classList = { add() {}, remove() {} }; }
    replaceChildren() { this.children = []; }
    append(node) { this.children.push(node); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    querySelector(tag) { return this.children.find(child => child.tag === tag); }
    pause() {}
    load() {}
  }
  return compile("ArticleVideo.ts", {
    "@tiptap/react": { Node: { create: options => options } },
    react: { createElement: (type, props) => ({ type, props }) },
    "react-dom/client": { createRoot: host => ({ render: content => { host.player = content; }, unmount() {} }) },
    "../../PrivateVideoPlayer": { default: "PrivateVideoPlayer" },
    "../../../lib/private-video-reference": privateReference,
  }, {
    document: { createElement: tag => new Element(tag) }, HTMLVideoElement: Element, HTMLElement: Element, queueMicrotask,
  });
}

test("editor video policy only allows the configured canonical permanent OSS namespace", () => {
  const { isArticleVideoUrl: accepts } = videoModule();
  assert.equal(accepts(src, base), true);
  assert.equal(accepts(src, `${base}/`), true);
  for (const value of [src + "?token=secret", src + "#t=3", src.replace("https:", "http:"), "/api/admin/video-imports/id/file", "blob:https://example.com/id", src.replace("media.example.com", "evil.example.com"), src.replace("/video.mp4", "/../video.mp4"), src.replace(id, "not-an-id"), src.replace("https://", "https://user:password@"), ` ${src}`, src.replace(id, id.replace("4111", "1111"))]) assert.equal(accepts(value, base), false, value);
  assert.equal(accepts(src, null), false);
});

test("video node preserves draft source but never loads an unapproved URL and forces safe playback attributes", () => {
  const { ArticleVideo: extension } = videoModule();
  const node = { type: "articleVideo", attrs: { src, title: "Fixture", autoplay: true, poster: "https://evil.example.com/x" } };
  const html = extension.renderHTML({ node });
  assert.equal(html[0], "video"); assert.equal(html[1].src, src); assert.equal(html[1].controls, "");
  assert.equal(html[1].playsinline, ""); assert.equal(html[1].preload, "metadata");
  assert.equal(html[1].autoplay, undefined); assert.equal(html[1].poster, undefined);
  const create = extension.addNodeView.call({ options: { articleVideoBaseUrl: base } });
  const view = create({ node });
  assert.equal(view.dom.children[0].tag, "video"); assert.equal(view.dom.children[0].src, src);
  assert.equal(view.dom.children[0].controls, true); assert.equal(view.dom.children[0].playsInline, true);
  const invalidNode = { ...node, attrs: { src: "https://evil.example.com/movie.mp4", title: "Invalid" } };
  assert.equal(view.update(invalidNode), true);
  assert.equal(view.dom.children[0].tag, "p"); assert.equal(view.dom.children[0].src, undefined);
  assert.match(view.dom.children[0].textContent, /暂不可预览/);
  assert.equal(extension.renderHTML({ node: invalidNode })[1].src, invalidNode.attrs.src);
  assert.equal(view.update({ type: "paragraph", attrs: {} }), false);
  view.destroy();
});

test("private node persists only its resource ID and previews through the explicit admin player", () => {
  const { ArticleVideo: extension } = videoModule();
  const node = { type: "articleVideo", attrs: { src: "https://evil.example.com/leak.mp4", assetId: id, title: "Private fixture" } };
  const html = extension.renderHTML({ node });
  assert.equal(html[1]["data-private-video-id"], id);
  assert.equal(html[1].src, undefined);
  const view = extension.addNodeView.call({ options: { articleVideoBaseUrl: null } })({ node });
  assert.equal(view.dom.children[0].player.props.assetId, id);
  assert.equal(view.dom.children[0].player.props.admin, true);
  assert.equal(view.dom.children[0].src, undefined);
  view.destroy();
});

async function pickerHarness() {
  const states = [], effects = [], requests = [], inserts = [], confirmations = [];
  let cursor = 0, tree, timer, cleanup, confirm = false, closed = 0;
  const job = { id, title: "Fixture video", status: "completed", fileBytes: 100, bytes: 100, createdAt: 0, duration: 2 };
  const data = { jobs: [job], oss: { ready: true, message: "" }, articleVideoBaseUrl: base };
  const jsx = (type, props) => ({ type, props: props || {} });
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
    useRef(initial) { const index = cursor++; return states[index] ||= { current: initial }; },
    useId() { return `id-${cursor++}`; },
    useCallback(callback) { return callback; },
    useEffect(callback) { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(callback); } },
  };
  const picker = compile("VideoPicker.tsx", {
    react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx }, "./ArticleVideo": videoModule(),
    "../../../lib/private-video-reference": privateReference,
    "./VideoPicker.module.css": { default: new Proxy({}, { get: (_target, key) => key }) },
  }, {
    AbortController, document: { hidden: false }, window: { confirm: message => { confirmations.push(message); return confirm; } },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => { timer = null; },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      if (options.method === "POST") { job.publication = { status: "uploading", progress: 0 }; return { ok: true, status: 202, json: async () => ({ job: structuredClone(job) }) }; }
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    },
  });
  const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : String(node ?? "");
  const render = () => {
    cursor = 0; tree = picker.VideoPicker({ onClose: () => { closed++; }, onInsert: video => { inserts.push(video); }, articleVideoBaseUrl: base });
    tree.props.ref.current ||= { showModal() {}, close() {} };
  };
  const find = predicate => { const found = nodes(tree).find(predicate); assert.ok(found, "Expected UI element"); return found; };
  const button = label => find(node => node.type === "button" && text(node) === label);
  render(); cleanup = effects[0](); await flush(); render();
  return {
    requests, inserts, confirmations, job, button, render, find, cleanup,
    nodes: () => nodes(tree), setConfirm(value) { confirm = value; }, closed: () => closed,
    async poll() { assert.ok(timer); await timer(); await flush(); render(); },
  };
}

test("video picker never uploads or inserts on open; preview is loaded only after explicit click", async () => {
  const h = await pickerHarness();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, "/api/admin/video-imports");
  assert.equal(h.inserts.length, 0); assert.equal(h.nodes().some(node => node.type === "video"), false);
  assert.equal(h.button("插入正文").props.disabled, true);
  h.button("预览本地视频").props.onClick(); h.render();
  assert.equal(h.find(node => node.type === "video").props.src, `/api/admin/video-imports/${id}/file`);
  h.button("关闭预览").props.onClick(); h.render();
  assert.equal(h.nodes().some(node => node.type === "video"), false);
  h.cleanup(); assert.equal(h.requests[0].signal.aborted, true);
});

test("OSS upload requires private-access confirmation and completed upload still needs manual insertion", async () => {
  const h = await pickerHarness();
  h.button("加密上传至 OSS").props.onClick(); await flush(); h.render();
  assert.equal(h.requests.some(request => request.method === "POST"), false);
  assert.match(h.confirmations[0], /加密.*私有目录.*访问码/);
  h.setConfirm(true); h.button("加密上传至 OSS").props.onClick(); await flush(); h.render();
  const post = h.requests.find(request => request.method === "POST");
  assert.equal(post.url, `/api/admin/video-imports/${id}/oss`); assert.deepEqual(JSON.parse(post.body), { authorized: true });
  assert.equal(h.button("插入正文").props.disabled, true); assert.equal(h.inserts.length, 0);
  h.job.publication = { status: "uploaded", progress: 100, url: src }; await h.poll();
  assert.equal(h.button("插入正文").props.disabled, false); assert.equal(h.inserts.length, 0);
  h.button("插入正文").props.onClick();
  assert.equal(h.inserts[0].src, src); assert.equal(h.closed(), 1); h.cleanup();
});

test("private upload inserts stable asset identity without a public or expiring URL", async () => {
  const h = await pickerHarness();
  h.job.publication = { kind: "private", assetId: id, status: "uploaded", progress: 100 }; await h.poll();
  assert.equal(h.button("插入正文").props.disabled, false);
  h.button("插入正文").props.onClick();
  assert.equal(h.inserts[0].assetId, id);
  assert.equal(h.inserts[0].src, undefined);
  h.cleanup();
});

test("uploaded but unapproved video URLs remain non-insertable", async () => {
  const h = await pickerHarness();
  h.job.publication = { status: "uploaded", progress: 100, url: "https://evil.example.com/video.mp4" }; await h.poll();
  assert.equal(h.button("插入正文").props.disabled, true);
  assert.equal(h.nodes().some(node => node.type === "button" && node.props.children === "按当前配置重新上传 OSS"), false);
  h.button("插入正文").props.onClick(); assert.equal(h.inserts.length, 0); h.cleanup();
});
