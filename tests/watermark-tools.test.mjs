import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const articleId = "11111111-1111-4111-8111-111111111111";
const sources = ["a", "b"].map(letter => `/uploads/articles/${articleId}/${letter.repeat(24)}.jpg`);
const initialSettings = { template: "old-template", relativeWidth: 0.42, mode: "inpaint", search: "bottom-right", threshold: 0.86, opacity: 0.7, padding: 6 };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(savedSettings = initialSettings) {
  const states = [], effects = [], requests = [], pending = [], applied = [], previews = [];
  let cursor = 0, tree;
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      return states[index] ||= { current: initial };
    },
    useMemo: callback => callback(),
    useEffect(callback) { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(callback); } },
  };
  const context = vm.createContext({
    AbortController,
    DOMParser: class { parseFromString() { return { querySelectorAll: () => sources.map(src => ({ getAttribute: () => src })) }; } },
    fetch: async (_url, options) => {
      if (!options?.method) return { ok: true, json: async () => ({ settings: savedSettings }) };
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => pending.push(resolve));
    },
  });
  const source = readFileSync(new URL("../app/ops-7q4m/editor/WatermarkTools.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${outputText}\n})`, context)(name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name.endsWith("article-image-limits")) return { MAX_IMAGES_PER_ARTICLE: 100 };
    throw new Error(`Unexpected import: ${name}`);
  }, loaded, loaded.exports);
  const render = () => {
    cursor = 0;
    tree = loaded.exports.WatermarkTools({ articleId, content: "fixture", disabled: false, onBusy() {}, onApply: p => applied.push(p), onPreview: p => previews.push(p) });
    return tree;
  };
  const nodes = node => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(n => nodes(n));
    return [node, ...nodes(node.props?.children)];
  };
  const text = node => Array.isArray(node) ? node.map(text).join("") : typeof node === "object" && node !== null ? text(node.props?.children) : String(node ?? "");
  const find = predicate => { const found = nodes(tree).find(predicate); assert.ok(found, "Expected UI element"); return found; };
  const button = label => find(n => n.type === "button" && text(n).includes(label));
  const notice = () => text(find(n => n.props.className === "watermark-calibration-status"));
  const authorize = () => { find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } }); render(); };
  const respond = async (ok, data) => { assert.ok(pending.length); pending.shift()({ ok, status: ok ? 200 : 422, json: async () => data }); await flush(); render(); };
  render(); effects.forEach(callback => callback()); await flush(); render();
  button("水印模板与参数").props.onClick(); render();
  return { render, find, button, notice, authorize, respond, requests, applied, previews };
}

test("calibration shows authorization feedback beside the button without sending requests", async () => {
  const h = await harness();
  h.button("从样图区域提取").props.onClick(); h.render();
  assert.match(h.notice(), /尚未开始提取.*勾选/);
  assert.equal(h.requests.length, 0);
});

test("changing sample updates image and extraction request, with loading and completion feedback", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "select" && n.props.value === "").props.onChange({ target: { value: sources[1] } }); h.render();
  assert.equal(h.find(n => n.type === "img" && n.props.alt.includes("样图")).props.src, sources[1]);
  assert.match(h.notice(), /样图已更换/);
  h.button("从样图区域提取").props.onClick(); h.render();
  assert.equal(h.requests[0].source, sources[1]);
  assert.equal(h.requests[0].color, "yellow");
  assert.deepEqual(h.requests[0].region, [0.57, 0.83, 0.42, 0.16]);
  assert.equal(h.button("正在提取黄色水印模板").props.disabled, true);
  assert.match(h.notice(), /第 2 张/);
  await h.respond(true, { settings: { ...initialSettings, template: "new-template" } });
  assert.match(h.notice(), /第 2 张.*已更新/);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,new-template");
  assert.match(h.notice(), /不会改变正文图片/);
  assert.equal(h.previews.length, 0); assert.equal(h.applied.length, 0);
});

test("failed calibration explicitly retains previous preview and displays server reason", async () => {
  const h = await harness(); h.authorize();
  h.button("从样图区域提取").props.onClick(); h.render();
  await h.respond(false, { detail: "选区中没有足够的黄色像素" });
  assert.match(h.notice(), /提取失败.*没有足够的黄色像素.*仍显示原模板/);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,old-template");
  assert.equal(h.button("从样图区域提取").props.disabled, false);
});

test("identical extraction is reported as identical rather than a silent refresh", async () => {
  const h = await harness(); h.authorize();
  h.button("从样图区域提取").props.onClick(); h.render();
  await h.respond(true, { settings: initialSettings });
  assert.match(h.notice(), /本次模板与原模板相同/);
});

test("out of bounds region is rejected locally and not shown as a valid overlay", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "input" && n.props.value === 57).props.onChange({ target: { value: "80" } }); h.render();
  h.button("从样图区域提取").props.onClick(); h.render();
  assert.match(h.notice(), /提取范围无效/);
  assert.equal(h.requests.length, 0);
});

test("black color selection changes labels and request only; failure retains the old template", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.onChange({ target: { value: "black" } }); h.render();
  assert.match(h.notice(), /颜色已更换.*尚未改变/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,old-template");
  h.button("从样图区域提取黑色水印模板").props.onClick(); h.render();
  assert.equal(h.requests[0].color, "black");
  assert.match(h.notice(), /黑色/);
  assert.equal(h.button("正在提取黑色水印模板").props.disabled, true);
  assert.equal(h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.disabled, true);
  await h.respond(false, { detail: "没有提取到可靠的黑色文字" });
  assert.match(h.notice(), /提取失败.*黑色.*仍显示原模板/);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,old-template");
  h.button("从样图区域提取黑色水印模板").props.onClick(); h.render();
  await h.respond(true, { settings: { ...initialSettings, extractionColor: "black", template: "black-template" } });
  assert.match(h.notice(), /黑色模板已提取并保存.*预览已更新/);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,black-template");
  assert.equal(h.previews.length, 0); assert.equal(h.applied.length, 0);
});

test("loading a saved black template restores the extraction color and can switch back to yellow", async () => {
  const h = await harness({ ...initialSettings, extractionColor: "black" });
  assert.ok(h.button("从样图区域提取黑色水印模板"));
  h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.onChange({ target: { value: "yellow" } }); h.render();
  assert.ok(h.button("从样图区域提取黄色水印模板"));
  assert.equal(h.requests.length, 0);
});

test("outlined-yellow extraction sends the chosen radius and updates only the template after success", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.onChange({ target: { value: "yellow-outline" } }); h.render();
  const radius = h.find(n => n.type === "input" && n.props["aria-label"] === "描边检测范围（像素）");
  assert.equal(radius.props.value, 4);
  assert.equal(radius.props.min, "1"); assert.equal(radius.props.max, "12");
  radius.props.onChange({ target: { value: "6" } }); h.render();
  assert.match(h.notice(), /描边检测范围已更换.*重新生成模板.*尚未改变/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,old-template");
  h.button("从样图区域提取黄色＋黑色描边水印模板").props.onClick(); h.render();
  assert.equal(h.requests[0].color, "yellow-outline"); assert.equal(h.requests[0].outlineRadius, 6);
  assert.equal(h.find(n => n.type === "input" && n.props["aria-label"] === "描边检测范围（像素）").props.disabled, true);
  await h.respond(true, { settings: { ...initialSettings, template: "outlined-template", extractionColor: "yellow-outline", outlineRadius: 6, search: "bottom", padding: 1 } });
  assert.match(h.notice(), /黄色＋黑色描边模板已提取并保存.*预览已更新/);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,outlined-template");
  assert.equal(h.find(n => n.type === "select" && n.props["aria-label"] === "搜索区域").props.value, "bottom");
  assert.equal(h.find(n => n.type === "select" && n.props["aria-label"] === "处理方式").props.value, "inpaint");
  assert.equal(h.find(n => n.type === "option" && n.props.value === "inverse").props.disabled, true);
  assert.equal(h.previews.length, 0); assert.equal(h.applied.length, 0);
});

test("saved outlined template restores color/radius and keeps its mode restriction when extraction choice changes", async () => {
  const h = await harness({ ...initialSettings, extractionColor: "yellow-outline", outlineRadius: 7, search: "bottom", padding: 1 });
  assert.ok(h.button("从样图区域提取黄色＋黑色描边水印模板"));
  assert.equal(h.find(n => n.type === "input" && n.props["aria-label"] === "描边检测范围（像素）").props.value, 7);
  assert.equal(h.find(n => n.type === "select" && n.props["aria-label"] === "搜索区域").props.value, "bottom");
  assert.equal(h.find(n => n.type === "option" && n.props.value === "inverse").props.disabled, true);
  h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.onChange({ target: { value: "yellow" } }); h.render();
  assert.ok(h.button("从样图区域提取黄色水印模板"));
  assert.equal(h.find(n => n.type === "option" && n.props.value === "inverse").props.disabled, true, "pending extraction color cannot change the existing template mode");
  assert.equal(h.requests.length, 0);
});

test("failed outlined extraction keeps prior preview and settings without applying article changes", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.onChange({ target: { value: "yellow-outline" } }); h.render();
  h.button("从样图区域提取黄色＋黑色描边水印模板").props.onClick(); h.render();
  await h.respond(false, { detail: "选区中的描边占比过大，请缩小选区" });
  assert.match(h.notice(), /提取失败.*描边占比过大.*仍显示原模板/);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,old-template");
  assert.equal(h.find(n => n.type === "select" && n.props["aria-label"] === "搜索区域").props.value, "bottom-right");
  assert.equal(h.find(n => n.type === "option" && n.props.value === "inverse").props.disabled, false);
  assert.equal(h.previews.length, 0); assert.equal(h.applied.length, 0);
});

test("invalid outline radius is rejected before a request without replacing the existing template", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "select" && n.props["aria-label"] === "提取颜色").props.onChange({ target: { value: "yellow-outline" } }); h.render();
  for (const value of ["0", "13", "1.5"]) {
    h.find(n => n.type === "input" && n.props["aria-label"] === "描边检测范围（像素）").props.onChange({ target: { value } }); h.render();
    h.button("从样图区域提取黄色＋黑色描边水印模板").props.onClick(); h.render();
    assert.match(h.notice(), /1 至 12 的整数像素/);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.find(n => n.type === "img" && n.props.className === "watermark-template-preview").props.src, "data:image/png;base64,old-template");
});

test("bottom-area search can be saved for a pre-existing template without changing its extraction type", async () => {
  const h = await harness(); h.authorize();
  h.find(n => n.type === "select" && n.props["aria-label"] === "搜索区域").props.onChange({ target: { value: "bottom" } }); h.render();
  h.button("保存模板与参数").props.onClick(); h.render();
  assert.equal(h.requests[0].action, "save-template");
  assert.equal(h.requests[0].settings.search, "bottom");
  assert.equal(h.requests[0].settings.template, "old-template");
  assert.equal(h.requests[0].settings.extractionColor, undefined);
  assert.equal(h.requests[0].settings.outlineRadius, undefined);
  await h.respond(true, { settings: { ...initialSettings, search: "bottom" } });
  assert.equal(h.previews.length, 0); assert.equal(h.applied.length, 0);
});

for (const allowLossyOutput of [true, false]) {
  test(`oversized-result compression defaults on and sends the explicit choice ${allowLossyOutput}`, async () => {
    const h = await harness(); h.authorize();
    const checkbox = h.find(n => n.type === "input" && n.props["aria-label"] === "超大结果压缩");
    assert.equal(checkbox.props.checked, true);
    if (!allowLossyOutput) { checkbox.props.onChange({ target: { checked: false } }); h.render(); }
    h.button("一键去水印并加深巷水印").props.onClick(); h.render();
    for (let i = 0; i < sources.length; i++) {
      assert.equal(h.requests[i].action, "process");
      assert.equal(h.requests[i].settings.allowLossyOutput, allowLossyOutput);
      await h.respond(false, { detail: "本测试不生成真实图片" });
    }
    assert.equal(h.applied.length, 0);
  });
}
