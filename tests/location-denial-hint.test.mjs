import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the real components with only their browser/hook boundaries replaced.
// This keeps permission callbacks and retry timing under test without a browser,
// real coordinates, network requests, or another testing dependency.
function mount(relativePath, { initialGate } = {}) {
  const hooks = [];
  const timers = new Map();
  const storage = new Map();
  const locationRequests = [];
  const networkRequests = [];
  let cursor = 0;
  let now = 0;
  let timerId = 0;
  let dirty = true;
  let tree;
  let pendingEffects = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) {
        hooks[index] = { value: initialGate && initial === "closed" ? initialGate : initial };
      }
      return [hooks[index].value, (value) => {
        hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value;
        dirty = true;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      return (hooks[index] ??= { current: initial });
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { dependencies, cleanup: callback() };
        });
      }
    },
    useEffectEvent(callback) { return callback; },
  };
  const jsx = (type, props) => ({ type, props });
  const browser = {
    isSecureContext: true,
    setTimeout(callback, delay = 0) {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { throw new Error("Unexpected background refresh without location consent"); },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    location: { assign() { throw new Error("Unexpected navigation"); } },
  };
  const context = vm.createContext({
    window: browser,
    document: { body: { style: { overflow: "" } } },
    navigator: {
      geolocation: {
        getCurrentPosition(success, error, options) { locationRequests.push({ success, error, options }); },
      },
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    crypto: { randomUUID: () => "location-test-request" },
    performance: { now: () => now },
    console: { info() {} },
    fetch(...args) {
      networkRequests.push(args);
      throw new Error("Unexpected network access");
    },
    AbortController,
    AbortSignal,
  });
  function load(relative, imports = {}) {
    const filename = new URL(`../${relative}`, import.meta.url);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: filename.pathname,
    });
    const loadedModule = { exports: {} };
    const execute = vm.runInContext(`(function (require, module, exports) { ${outputText}\n})`, context);
    execute((name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    }, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  const consent = load("lib/location-consent-browser.ts");
  const Component = load(relativePath, {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/navigation": { usePathname: () => "/" },
    "../lib/location-consent-browser": consent,
    "../../../lib/location-consent-browser": consent,
  }).default;
  function render() {
    for (let pass = 0; dirty; pass++) {
      assert.ok(pass < 20, "Component did not settle");
      dirty = false;
      cursor = 0;
      pendingEffects = [];
      tree = Component();
      for (const effect of pendingEffects) effect();
    }
  }
  function nodes(predicate, node = tree) {
    if (Array.isArray(node)) return node.flatMap((child) => nodes(predicate, child));
    if (!node || typeof node !== "object") return [];
    return [...(predicate(node) ? [node] : []), ...nodes(predicate, node.props?.children ?? null)];
  }
  async function advance(milliseconds) {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
      render();
    }
    now = end;
    render();
  }
  render();
  return {
    advance, nodes, storage, locationRequests, networkRequests,
    message: consent.LOCATION_PERMISSION_DENIED_MESSAGE,
    action(node, name = "onClick", event) { node.props[name](event); render(); },
    fail(code = 1) {
      locationRequests.at(-1).error({ code, message: "fixture geolocation error" });
      render();
    },
    dispose() { for (const hook of hooks) hook?.cleanup?.(); timers.clear(); },
  };
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") return text(node.props?.children);
  return typeof node === "string" ? node : "";
}

for (const [label, filename, delay, buttonLabel] of [
  ["home", "app/page.tsx", 0, "获取同城黑料"],
  ["article", "app/articles/[id]/ArticleLocationGate.tsx", 2500, "发现同城黑料"],
]) {
  test(`${label}: permission denial returns an actionable hint after 3 seconds; retry requires a click`, async (t) => {
    const page = mount(filename);
    t.after(() => page.dispose());
    await page.advance(delay);
    const button = () => page.nodes((node) => node.type === "button" && text(node) === buttonLabel)[0];
    assert.ok(button());
    assert.equal(page.locationRequests.length, 0);
    page.action(button());
    assert.equal(page.locationRequests.length, 1);
    page.fail();
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    await page.advance(2999);
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    await page.advance(1);
    const [alert] = page.nodes((node) => node.props?.role === "alert");
    assert.equal(text(alert), page.message);
    assert.match(text(alert), /退出当前页面后重新进入/);
    assert.match(text(alert), /若再次出现.*请选择“允许”/);
    assert.match(text(alert), /如果没有再次弹出提示.*浏览器的网站设置/);
    assert.equal(button().props["aria-describedby"], alert.props.id);
    await page.advance(60000);
    assert.equal(page.locationRequests.length, 1, "The retry dialog must not collect location automatically");
    assert.equal(page.networkRequests.length, 0);
    assert.equal(page.storage.has("shenxiang_location"), false);
    page.action(button());
    assert.equal(page.locationRequests.length, 2);
    assert.equal(page.nodes((node) => node.props?.role === "alert").length, 0, "A new request clears the stale denial hint");
    page.fail(3);
    await page.advance(3000);
    assert.equal(page.nodes((node) => node.props?.role === "alert" && text(node) === page.message).length, 0,
      "Timeouts must not be mislabelled as permission denials");
    assert.equal(page.networkRequests.length, 0);
  });
}

test("member optional precision: denial keeps the current choice dialog and city-only never requests coordinates", (t) => {
  // Mount the existing member step directly; no production navigation is changed.
  const page = mount("app/page.tsx", { initialGate: "location" });
  t.after(() => page.dispose());
  const checkbox = () => page.nodes((node) => node.type === "input" && node.props.type === "checkbox")[0];
  const save = () => page.nodes((node) => node.type === "button" && /定位并进入|仅保存城市并进入/.test(text(node)))[0];
  page.action(checkbox(), "onChange", { target: { checked: true } });
  page.action(save());
  page.fail();
  const [alert] = page.nodes((node) => node.props?.id === "member-location-error");
  assert.equal(text(alert), page.message);
  assert.ok(checkbox(), "Denial must preserve the optional-precision step");
  assert.equal(save().props["aria-describedby"], "member-location-error");
  page.action(save());
  assert.equal(page.locationRequests.length, 2);
  assert.equal(page.nodes((node) => node.props?.role === "alert").length, 0);
  page.fail();
  page.action(checkbox(), "onChange", { target: { checked: false } });
  page.action(save());
  assert.equal(page.locationRequests.length, 2);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  assert.equal(JSON.parse(page.storage.get("shenxiang_location")).precision, "city");
  assert.equal(page.networkRequests.length, 0);
});
