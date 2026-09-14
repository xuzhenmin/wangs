import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const base = "https://media.example.com/article-videos";
const id = "11111111-1111-4111-8111-111111111111";
const src = `${base}/${id}/video.mp4`;
const flush = () => new Promise(resolve => setImmediate(resolve));

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
  return compile("ArticleVideo.ts", { "@tiptap/react": { Node: { create: options => options } } }, {
    document: { createElement: tag => new Element(tag) }, HTMLVideoElement: Element,
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

test("OSS upload requires public-access confirmation and completed upload still needs manual insertion", async () => {
  const h = await pickerHarness();
  h.button("上传至 OSS").props.onClick(); await flush(); h.render();
  assert.equal(h.requests.some(request => request.method === "POST"), false);
  assert.match(h.confirmations[0], /任何人均可访问/);
  h.setConfirm(true); h.button("上传至 OSS").props.onClick(); await flush(); h.render();
  const post = h.requests.find(request => request.method === "POST");
  assert.equal(post.url, `/api/admin/video-imports/${id}/oss`); assert.deepEqual(JSON.parse(post.body), { authorized: true });
  assert.equal(h.button("插入正文").props.disabled, true); assert.equal(h.inserts.length, 0);
  h.job.publication = { status: "uploaded", progress: 100, url: src }; await h.poll();
  assert.equal(h.button("插入正文").props.disabled, false); assert.equal(h.inserts.length, 0);
  h.button("插入正文").props.onClick();
  assert.equal(h.inserts[0].src, src); assert.equal(h.closed(), 1); h.cleanup();
});

test("uploaded but unapproved video URLs remain non-insertable", async () => {
  const h = await pickerHarness();
  h.job.publication = { status: "uploaded", progress: 100, url: "https://evil.example.com/video.mp4" }; await h.poll();
  assert.equal(h.button("插入正文").props.disabled, true);
  assert.equal(h.button("按当前配置重新上传 OSS").props.disabled, false);
  h.button("插入正文").props.onClick(); assert.equal(h.inserts.length, 0); h.cleanup();
});
