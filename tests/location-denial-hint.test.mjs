import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the real components with only their browser/hook boundaries replaced.
// This keeps permission callbacks and retry timing under test without a browser,
// real coordinates, network requests, or another testing dependency.
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name) { for (const callback of [...(listeners.get(name) ?? [])]) callback({ type: name }); },
    listenerCount(name) { return listeners.get(name)?.size ?? 0; },
  };
}

function mount(relativePath, {
  initialGate,
  props = { content: "<p>Article fixture content</p>" },
  permissionsSupported = true,
  permissionQuery,
  initialStorage = [],
  permissionState = "denied",
  fetchResponse,
  consentStatusResponse,
  initialNow = Date.now(),
  showRegistration = false,
  // Location interaction tests use the legacy content route: the public home
  // now keeps its registration panel open and cannot enter that location flow.
  pathname = showRegistration ? "/" : "/content/167e223d0e93b2ca79f109233a61fd16e5f073cf8a832a13",
} = {}) {
  const hooks = [];
  const timers = new Map();
  const storage = new Map(initialStorage);
  const locationRequests = [];
  const networkRequests = [];
  const consentRequests = [];
  const permissionQueries = [];
  const permission = { ...eventTarget(), state: permissionState };
  let cursor = 0;
  let now = 0;
  let timerId = 0;
  let dirty = true;
  let tree;
  let pendingEffects = [];
  let disposed = false;
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
    ...eventTarget(),
    isSecureContext: true,
    setTimeout(callback, delay = 0) {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      timers.set(++timerId, { callback, at: now + delay, interval: delay });
      return timerId;
    },
    clearInterval(id) { timers.delete(id); },
    location: { assign() { throw new Error("Unexpected navigation"); } },
  };
  const browserDocument = { ...eventTarget(), body: { style: { overflow: "" } }, visibilityState: "visible" };
  const context = vm.createContext({
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [initialNow + now])); }
      static now() { return initialNow + now; }
    },
    window: browser,
    document: browserDocument,
    navigator: {
      ...(permissionsSupported ? { permissions: {
        query(options) {
          permissionQueries.push(options);
          return permissionQuery ? permissionQuery(permission) : Promise.resolve(permission);
        },
      } } : {}),
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
      if (args[0] === "/api/location/consent-status") {
        consentRequests.push(args);
        if (consentStatusResponse) return consentStatusResponse(...args);
        if (fetchResponse) return fetchResponse(...args);
        return Promise.resolve({ ok: true, json: async () => ({ revoked: false }) });
      }
      networkRequests.push(args);
      if (fetchResponse) return fetchResponse(...args);
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
    "next/navigation": { usePathname: () => pathname },
    "../lib/location-consent-browser": consent,
    "../../../lib/location-consent-browser": consent,
    "./ArticleContentDisclosure": { default: "article-content-disclosure-fixture" },
    "./WechatShare": { default: "wechat-share-fixture" },
    "./HomeHeadlines": { default: "home-headlines-fixture" },
  }).default;
  function render() {
    if (disposed) return;
    for (let pass = 0; dirty; pass++) {
      assert.ok(pass < 20, "Component did not settle");
      dirty = false;
      cursor = 0;
      pendingEffects = [];
      tree = Component(props);
      for (const effect of pendingEffects) effect();
    }
  }
  async function settle() {
    // The component awaits permissions and both location-processing requests.
    // Flush the microtask chain deterministically without real delays.
    for (let pass = 0; pass < 20; pass++) {
      await Promise.resolve();
      render();
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
      if (next[1].interval) timers.set(next[0], { ...next[1], at: now + next[1].interval });
      next[1].callback();
      await settle();
    }
    now = end;
    render();
  }
  render();
  return {
    advance, settle, nodes, storage, locationRequests, networkRequests, consentRequests, permissionQueries,
    permission, browser, browserDocument,
    disclosure: () => nodes((node) => node.type === "article-content-disclosure-fixture")[0]?.props,
    message: consent.LOCATION_PERMISSION_DENIED_MESSAGE,
    action(node, name = "onClick", event) { const result = node.props[name](event); render(); return result; },
    fail(code = 1) {
      locationRequests.at(-1).error({ code, message: "fixture geolocation error" });
      render();
    },
    succeed() {
      permission.state = "granted";
      const pending = locationRequests.at(-1).success({
        coords: { latitude: 0, longitude: 0, accuracy: 100 }, timestamp: 0,
      });
      render();
      return pending;
    },
    async permissionChange(state) {
      permission.state = state;
      permission.dispatch("change");
      await settle();
    },
    async focus() { browser.dispatch("focus"); await settle(); },
    async visibility(state) {
      browserDocument.visibilityState = state;
      browserDocument.dispatch("visibilitychange");
      await settle();
    },
    dispose() {
      disposed = true;
      for (const hook of hooks) hook?.cleanup?.();
      timers.clear();
    },
  };
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") return text(node.props?.children);
  return typeof node === "string" ? node : "";
}

for (const [label, filename, delay, buttonLabel] of [
  ["legacy content", "app/page.tsx", 2000, "获取同城黑料"],
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
    assert.equal(text(alert), "位置访问被拒绝，如需继续访问，请退出后重新打开网站。");
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

function articleButton(page, label = "获取同城黑料") {
  return page.nodes((node) => node.type === "button" && (node.props["aria-label"] || text(node)) === label)[0];
}

for (const permissionsSupported of [true, false]) {
  test(`article: closes its dialog before the native decision without waiting text (permissions API: ${permissionsSupported})`, async (t) => {
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx", { permissionsSupported });
    t.after(() => page.dispose());
    await page.advance(2500);
    page.action(articleButton(page));
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.equal(page.browserDocument.body.style.overflow, "");
    assert.equal(page.nodes((node) => /正在获取位置/.test(text(node))).length, 0);
    assert.equal(articleButton(page, "展开").props.disabled, true);
    // A browser may report the permission decision before it supplies coordinates.
    await page.permissionChange("granted");
    await page.advance(1000);
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.equal(page.storage.has("shenxiang_location_authorized_at"), false);
    assert.equal(page.disclosure().collapsed, true);
    await page.succeed();
    await page.settle();
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.ok(articleButton(page, "展开"));
    assert.equal(page.disclosure().collapsed, true);
    page.action(articleButton(page, "展开"));
    await page.settle();
    assert.equal(page.disclosure().collapsed, false);
  });
}

const consentTtl = 100 * 24 * 60 * 60 * 1000;
const authorizedAtKey = "shenxiang_location_authorized_at";
const expiryKey = "shenxiang_location_consent_expires_at";
function savedConsent(at = Date.now() - 60000) {
  return [[authorizedAtKey, String(at)], [expiryKey, String(at + consentTtl)], ["shenxiang_member", "active"], ["shenxiang_device_id", "fixture-device"]];
}

for (const filename of ["app/page.tsx", "app/articles/[id]/ArticleLocationGate.tsx"]) {
  for (const [label, options] of [
    ["prompt", { permissionState: "prompt" }],
    ["unsupported Permissions API", { permissionsSupported: false }],
    ["failed permission query", { permissionQuery: async () => { throw new Error("unsupported"); } }],
  ]) {
    test(`${filename}: saved consent survives repeated visits with ${label} without automatic location requests`, async (t) => {
      let receipt = savedConsent();
      const originalExpiry = new Map(receipt).get(expiryKey);
      for (let visit = 0; visit < 2; visit++) {
        const page = mount(filename, { ...options, initialStorage: receipt });
        t.after(() => page.dispose());
        await page.advance(30 * 60 * 1000 + 3000);
        await page.focus();
        assert.equal(page.locationRequests.length, 0);
        assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
        assert.equal(page.storage.get(expiryKey), originalExpiry);
        assert.ok(page.storage.has(authorizedAtKey));
        if (filename.includes("ArticleLocationGate")) {
          assert.equal(page.disclosure().collapsed, true);
          page.action(articleButton(page, "展开"));
          await page.settle();
          assert.equal(page.disclosure().collapsed, false);
        }
        receipt = [...page.storage];
        page.dispose();
      }
    });
  }

  test(`${filename}: successful location saves consent even when upload fails, and reopening does not prompt`, async (t) => {
    const page = mount(filename, { initialStorage: [["shenxiang_member", "active"]] });
    t.after(() => page.dispose());
    await page.advance(2500);
    page.action(articleButton(page));
    const pending = page.succeed();
    assert.ok(page.storage.has(authorizedAtKey), "Consent must be saved before upload finishes");
    await pending;
    await page.settle();
    const reopened = mount(filename, {
      initialStorage: [...page.storage], permissionState: "prompt",
      fetchResponse: async () => ({ ok: true, json: async () => ({ revoked: false }) }),
    });
    t.after(() => reopened.dispose());
    await reopened.advance(6000);
    assert.equal(reopened.locationRequests.length, 0);
    assert.equal(reopened.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.equal(reopened.storage.get(expiryKey), page.storage.get(expiryKey));
  });

  test(`${filename}: stale revisits refresh immediately and after 30 minutes without renewing consent`, async (t) => {
    const initialNow = Date.now();
    const receipt = savedConsent(initialNow - 31 * 60 * 1000);
    const page = mount(filename, { initialNow, initialStorage: receipt, permissionState: "granted" });
    t.after(() => page.dispose());
    await page.advance(0);
    assert.equal(page.locationRequests.length, 1);
    await page.succeed();
    await page.settle();
    await page.advance(30 * 60 * 1000 - 1);
    assert.equal(page.locationRequests.length, 1);
    await page.advance(1);
    assert.equal(page.locationRequests.length, 2);
    assert.equal(page.storage.get(expiryKey), new Map(receipt).get(expiryKey));
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  });

  test(`${filename}: a recent saved address is reused until exactly 30 minutes after its last update`, async (t) => {
    const initialNow = Date.now();
    const oldLocation = JSON.stringify({ city: "测试城市", address: "上次的地址", refreshedAt: new Date(initialNow - 10 * 60 * 1000).toISOString() });
    const receipt = [...savedConsent(initialNow - 86400000), ["shenxiang_location", oldLocation], ["shenxiang_location_last_refresh_at", String(initialNow - 10 * 60 * 1000)]];
    const page = mount(filename, { initialNow, initialStorage: receipt, permissionState: "granted" });
    t.after(() => page.dispose());
    await page.advance(0);
    assert.equal(page.locationRequests.length, 0);
    await page.advance(20 * 60 * 1000 - 1);
    assert.equal(page.locationRequests.length, 0);
    assert.equal(page.storage.get("shenxiang_location"), oldLocation);
    await page.advance(1);
    assert.equal(page.locationRequests.length, 1);
    page.fail(3);
    await page.settle();
    assert.equal(page.storage.get("shenxiang_location"), oldLocation, "A failed background refresh preserves the cached address");
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.equal(page.storage.get(expiryKey), new Map(receipt).get(expiryKey));
  });

  test(`${filename}: repeated visits and other-page updates do not cause redundant location requests`, async (t) => {
    const initialNow = Date.now();
    const refreshedAt = initialNow - 29 * 60 * 1000;
    const receipt = [...savedConsent(initialNow - 86400000), ["shenxiang_location_last_refresh_at", String(refreshedAt)]];
    for (const elapsed of [0, 30000]) {
      const page = mount(filename, { initialNow: initialNow + elapsed, initialStorage: receipt, permissionState: "granted" });
      t.after(() => page.dispose());
      await page.advance(0);
      assert.equal(page.locationRequests.length, 0);
      // A different tab saved a newer address before this tab's deadline.
      page.storage.set("shenxiang_location_last_refresh_at", String(initialNow + elapsed));
      await page.advance(60000 - elapsed);
      assert.equal(page.locationRequests.length, 0);
      page.dispose();
    }
  });

  test(`${filename}: a newly granted fix takes precedence over an old cached refresh timestamp`, async (t) => {
    const initialNow = Date.now();
    const page = mount(filename, {
      initialNow, permissionState: "granted",
      initialStorage: [...savedConsent(initialNow), ["shenxiang_location_last_refresh_at", String(initialNow - 86400000)]],
    });
    t.after(() => page.dispose());
    await page.advance(30 * 60 * 1000 - 1);
    assert.equal(page.locationRequests.length, 0);
    await page.advance(1);
    assert.equal(page.locationRequests.length, 1);
  });

  test(`${filename}: successful refresh is reused on reopening without extending the 100-day consent`, async (t) => {
    const initialNow = Date.now();
    const page = mount(filename, {
      initialNow, permissionState: "granted", initialStorage: savedConsent(initialNow - 86400000),
      fetchResponse: async () => ({ ok: true, status: 200, json: async () => ({ display_name: "缓存地址", address: { city: "缓存城市" } }) }),
    });
    t.after(() => page.dispose());
    await page.advance(0);
    assert.equal(page.locationRequests.length, 1);
    await page.succeed();
    await page.settle();
    const stored = [...page.storage];
    const reopened = mount(filename, { initialNow: initialNow + 10 * 60 * 1000, permissionState: "granted", initialStorage: stored });
    t.after(() => reopened.dispose());
    await reopened.advance(0);
    assert.equal(reopened.locationRequests.length, 0);
    assert.equal(JSON.parse(reopened.storage.get("shenxiang_location")).address, "缓存地址");
    assert.equal(reopened.storage.get(expiryKey), String(initialNow - 86400000 + consentTtl));
    await reopened.advance(20 * 60 * 1000);
    assert.equal(reopened.locationRequests.length, 1);
  });

  for (const reason of ["expired", "revoked"]) {
    test(`${filename}: ${reason} consent cannot suppress the confirmation dialog`, async (t) => {
      const page = mount(filename, {
        initialStorage: [...savedConsent(Date.now() - (reason === "expired" ? consentTtl + 1000 : 1000)), ["shenxiang_device_id", "fixture"]],
        permissionState: "granted",
        fetchResponse: async () => ({ ok: true, json: async () => ({ revoked: reason === "revoked" }) }),
      });
      t.after(() => page.dispose());
      await page.advance(2500);
      assert.ok(articleButton(page));
      assert.equal(page.locationRequests.length, 0);
      assert.equal(page.storage.has(authorizedAtKey), false);
    });
  }
}

test("article: existing receipts migrate without renewal, but city-only choices are not location permission", async (t) => {
  const consentedAt = new Date(Date.now() - 86400000).toISOString();
  for (const precise of [true, false]) {
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx", {
      permissionState: "prompt",
      initialStorage: [["shenxiang_location", JSON.stringify({ consentedAt, precision: precise ? "precise" : "city" })],
        ...(precise ? [[expiryKey, String(Date.parse(consentedAt) + consentTtl)]] : [])],
    });
    t.after(() => page.dispose());
    await page.advance(2500);
    assert.equal(page.locationRequests.length, 0);
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, precise ? 0 : 1);
    if (precise) assert.equal(page.storage.get(expiryKey), String(Date.parse(consentedAt) + consentTtl));
  }
});

async function collapseArticle(page) {
  await page.advance(2500);
  page.action(articleButton(page));
  page.fail(1);
  await page.advance(3000);
  page.action(articleButton(page));
  await page.settle();
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.locationRequests.length, 1, "Choosing the denied dialog preview must not request location again");
}

test("article: the repeated denial dialog switches to an inline preview without requesting location", async (t) => {
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx");
  t.after(() => page.dispose());
  await page.advance(2500);
  assert.equal(page.disclosure().content, "<p>Article fixture content</p>");
  assert.equal(page.disclosure().collapsed, true);
  page.action(articleButton(page));
  page.fail(1);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  await page.advance(2999);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  await page.advance(1);
  const [alert] = page.nodes((node) => node.props?.id === "article-location-error");
  assert.equal(text(alert), page.message);
  assert.equal(articleButton(page).props["aria-describedby"], alert.props.id);
  await page.advance(60000);
  assert.equal(page.locationRequests.length, 1);
  page.action(articleButton(page));
  await page.settle();
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  assert.ok(articleButton(page, "展开"));
  assert.equal(page.locationRequests.length, 1);
  assert.equal(page.networkRequests.length, 0);
  assert.equal(page.storage.has("shenxiang_location"), false);
  assert.ok(page.nodes((node) => node.props?.role === "status" && /允许位置访问后/.test(text(node))).length);
  assert.equal(page.nodes((node) => /1\/3|2\/3|一半|三分|50%/.test(text(node))).length, 0);

  page.action(articleButton(page, "展开"));
  assert.equal(page.locationRequests.length, 2, "Only the explicit inline retry requests location");
  page.fail(1);
  await page.advance(60000);
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0, "An inline failure must not reopen the blocking dialog");
  assert.equal(text(page.nodes((node) => node.props?.id === "article-location-inline-error")[0]), page.message);
  assert.equal(page.locationRequests.length, 2);
  assert.equal(page.networkRequests.length, 0);
});

test("article: permission grants without a device receipt require an explicit location request before expansion", async (t) => {
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx");
  t.after(() => page.dispose());
  await collapseArticle(page);
  assert.equal(page.permission.listenerCount("change"), 1);
  await page.permissionChange("prompt");
  assert.equal(page.disclosure().collapsed, true);
  await page.permissionChange("denied");
  assert.equal(page.disclosure().collapsed, true);
  await page.permissionChange("granted");
  assert.equal(page.disclosure().collapsed, true);
  assert.ok(articleButton(page, "展开"));
  page.action(articleButton(page, "展开"));
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.locationRequests.length, 2);
  await page.succeed();
  await page.settle();
  assert.equal(page.disclosure().collapsed, false);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  assert.equal(articleButton(page, "重新获取位置"), undefined);
  assert.equal(page.permission.listenerCount("change"), 1, "Permission monitoring remains active to detect later revocation");
  await page.permissionChange("denied");
  assert.equal(page.disclosure().collapsed, true);
  assert.ok(articleButton(page, "展开"));
  await page.permissionChange("granted");
  assert.equal(page.disclosure().collapsed, true);
  assert.ok(articleButton(page, "展开"));
  await page.permissionChange("prompt");
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.locationRequests.length, 2);
});

for (const signal of ["focus", "visibility"]) {
  test(`article: ${signal} rechecks permission after returning from browser settings`, async (t) => {
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx");
    t.after(() => page.dispose());
    await collapseArticle(page);
    const initialQueries = page.permissionQueries.length;
    if (signal === "visibility") {
      await page.visibility("hidden");
      assert.equal(page.permissionQueries.length, initialQueries, "Hiding the page must not recheck permission");
    }
    page.permission.state = "granted";
    if (signal === "focus") await page.focus();
    else await page.visibility("visible");
    assert.equal(page.disclosure().collapsed, true);
    page.action(articleButton(page, "展开"));
    assert.equal(page.disclosure().collapsed, true);
    await page.succeed();
    await page.settle();
    assert.equal(page.disclosure().collapsed, false);
    assert.ok(page.permissionQueries.length > initialQueries);
    assert.equal(page.permission.listenerCount("change"), 1, "Repeated queries must not accumulate listeners");
    assert.equal(page.locationRequests.length, 2);
  });
}

for (const [label, options] of [
  ["supported Permissions API", {}],
  ["unsupported Permissions API", { permissionsSupported: false }],
  ["rejected permission query", { permissionQuery: async () => { throw new Error("fixture unsupported query"); } }],
]) {
  test(`article: ${label} expands after the explicit expand request succeeds without waiting for storage`, async (t) => {
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx", options);
    t.after(() => page.dispose());
    await collapseArticle(page);
    await page.focus();
    assert.equal(page.disclosure().collapsed, true);
    assert.equal(page.locationRequests.length, 1);
    const expandButton = articleButton(page, "展开");
    assert.equal(text(expandButton), "", "The expand button is icon-only even before authorization");
    assert.equal(expandButton.props.children.type, "svg");
    page.action(expandButton);
    page.action(expandButton);
    assert.equal(page.locationRequests.length, 2);
    assert.equal(page.disclosure().collapsed, true, "Waiting for authorization must not reveal content");
    const pending = page.succeed();
    assert.equal(page.disclosure().collapsed, false, "The explicit expand request completes only after location success");
    await pending;
    await page.settle();
    assert.equal(page.disclosure().collapsed, false, "A location-storage failure must not refold content");
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.match(text(page.nodes((node) => node.props?.role === "alert")[0]), /位置保存失败/);
    assert.deepEqual(page.networkRequests.map(([url]) => url), ["/api/reverse-geocode", "/api/location"]);
    await page.advance(3000);
    assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
    assert.equal(page.storage.has("shenxiang_location"), false);
  });
}

for (const errorCode of [1, 2, 3]) {
  test(`article: expanding without authorization stays folded on location error ${errorCode}`, async (t) => {
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx");
    t.after(() => page.dispose());
    await page.advance(0);
    const button = articleButton(page, "展开");
    assert.equal(button.props.children.type, "svg");
    page.action(button);
    page.action(button);
    assert.equal(page.locationRequests.length, 1);
    assert.equal(page.disclosure().collapsed, true);
    assert.equal(articleButton(page, "展开").props.disabled, true);
    page.fail(errorCode);
    assert.equal(page.disclosure().collapsed, true);
    assert.equal(page.storage.has(authorizedAtKey), false);
    assert.equal(articleButton(page, "展开").props.disabled, false);
    assert.equal(page.networkRequests.length, 0);
    await page.advance(3000);
    assert.equal(page.disclosure().collapsed, true);
  });
}

test("article: each expand checks the server and waits before revealing content", async (t) => {
  let finishCheck;
  let checks = 0;
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx", {
    initialStorage: savedConsent(), permissionState: "granted",
    consentStatusResponse: () => ++checks === 1
      ? Promise.resolve({ ok: true, json: async () => ({ revoked: false }) })
      : new Promise(resolve => { finishCheck = resolve; }),
  });
  t.after(() => page.dispose());
  await page.advance(0);
  const button = articleButton(page, "展开");
  page.action(button);
  page.action(button);
  assert.equal(checks, 2, "One initialization check and one click check, even on double click");
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(articleButton(page, "展开").props.disabled, true);
  assert.equal(articleButton(page, "展开").props["aria-busy"], true);
  const [url, request] = page.consentRequests.at(-1);
  assert.equal(url, "/api/location/consent-status");
  assert.equal(request.cache, "no-store");
  assert.equal(JSON.parse(request.body).deviceId, "fixture-device");
  finishCheck({ ok: true, json: async () => ({ revoked: false }) });
  await page.settle();
  assert.equal(page.disclosure().collapsed, false);
  assert.equal(page.locationRequests.length, 0);
});

test("article: a server revocation after page load overrides cached authorization on expand", async (t) => {
  let revoked = false;
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx", {
    initialStorage: savedConsent(), permissionState: "granted",
    consentStatusResponse: async () => ({ ok: true, json: async () => ({ revoked }) }),
  });
  t.after(() => page.dispose());
  await page.advance(0);
  revoked = true;
  page.action(articleButton(page, "展开"));
  await page.settle();
  assert.equal(page.consentRequests.length, 2);
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.storage.has(authorizedAtKey), false);
  assert.equal(page.locationRequests.length, 1);
  await page.succeed();
  await page.settle();
  assert.equal(page.disclosure().collapsed, false);
});

for (const failure of ["network", "http", "malformed"]) {
  test(`article: expand fails closed on ${failure} consent-check errors and can retry`, async (t) => {
    let fail = false;
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx", {
      initialStorage: savedConsent(), permissionState: "granted",
      consentStatusResponse: async () => {
        if (!fail) return { ok: true, json: async () => ({ revoked: false }) };
        if (failure === "network") throw new Error("fixture network failure");
        if (failure === "http") return { ok: false, status: 503 };
        return { ok: true, json: async () => ({}) };
      },
    });
    t.after(() => page.dispose());
    await page.advance(0);
    fail = true;
    page.action(articleButton(page, "展开"));
    await page.settle();
    assert.equal(page.disclosure().collapsed, true);
    assert.equal(page.locationRequests.length, 0);
    assert.equal(articleButton(page, "展开").props.disabled, false);
    assert.match(text(page.nodes(node => node.props?.role === "alert")[0]), /授权状态验证失败/);
    assert.ok(page.storage.has(authorizedAtKey), "Network failure must not delete an otherwise valid receipt");
    fail = false;
    page.action(articleButton(page, "展开"));
    await page.settle();
    assert.equal(page.disclosure().collapsed, false);
  });
}

test("article: leaving the page during a server check cannot start a location request", async (t) => {
  let finishCheck;
  let checks = 0;
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx", {
    initialStorage: savedConsent(), permissionState: "granted",
    consentStatusResponse: () => ++checks === 1
      ? Promise.resolve({ ok: true, json: async () => ({ revoked: false }) })
      : new Promise(resolve => { finishCheck = resolve; }),
  });
  t.after(() => page.dispose());
  await page.advance(0);
  page.action(articleButton(page, "展开"));
  page.dispose();
  finishCheck({ ok: true, json: async () => ({ revoked: true }) });
  await page.settle();
  assert.equal(page.locationRequests.length, 0);
  assert.equal(page.disclosure().collapsed, true);
});

test("article: a timeout remains a retry, not a permission-denied preview", async (t) => {
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx");
  t.after(() => page.dispose());
  await page.advance(2500);
  page.action(articleButton(page));
  page.fail(3);
  await page.advance(3000);
  assert.equal(page.disclosure().collapsed, true);
  const [alert] = page.nodes((node) => node.props?.role === "alert");
  assert.match(text(alert), /获取位置超时/);
  assert.notEqual(text(alert), page.message);
  page.action(articleButton(page));
  assert.equal(page.locationRequests.length, 2);
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.permissionQueries.length, 0);
  assert.equal(page.networkRequests.length, 0);
});

test("article: unmount removes permission and page listeners", async () => {
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx");
  await collapseArticle(page);
  assert.equal(page.permission.listenerCount("change"), 1);
  assert.equal(page.browser.listenerCount("focus"), 1);
  assert.equal(page.browserDocument.listenerCount("visibilitychange"), 1);
  const queries = page.permissionQueries.length;
  page.dispose();
  assert.equal(page.permission.listenerCount("change"), 0);
  assert.equal(page.browser.listenerCount("focus"), 0);
  assert.equal(page.browserDocument.listenerCount("visibilitychange"), 0);
  await page.permissionChange("granted");
  await page.focus();
  await page.visibility("visible");
  assert.equal(page.permissionQueries.length, queries);
  assert.equal(page.locationRequests.length, 1);
  assert.equal(page.networkRequests.length, 0);
});

test("article: a pending permission query cannot install a listener after unmount", async () => {
  let resolvePermission;
  const page = mount("app/articles/[id]/ArticleLocationGate.tsx", {
    permissionQuery: (permission) => new Promise((resolve) => { resolvePermission = () => resolve(permission); }),
  });
  await collapseArticle(page);
  assert.equal(page.permissionQueries.length, 1);
  page.dispose();
  resolvePermission();
  await page.settle();
  assert.equal(page.permission.listenerCount("change"), 0);
  assert.equal(page.browser.listenerCount("focus"), 0);
  assert.equal(page.browserDocument.listenerCount("visibilitychange"), 0);
  assert.equal(page.locationRequests.length, 1);
  assert.equal(page.networkRequests.length, 0);
});

test("member optional precision: denial keeps the current choice dialog and city-only never requests coordinates", (t) => {
  // Mount the existing member step directly; no production navigation is changed.
  const page = mount("app/page.tsx", { initialGate: "location", pathname: "/content/167e223d0e93b2ca79f109233a61fd16e5f073cf8a832a13" });
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

test("home: guest sees the generic introduction and persistent registration panel", async (t) => {
  const page = mount("app/page.tsx", { showRegistration: true });
  t.after(() => page.dispose());
  await page.advance(0);
  assert.equal(text(page.nodes(node => node.type === "h1")[0]), "发现热点，关注身边事。");
  assert.equal(page.nodes(node => node.props?.className === "news-consent-backdrop").length, 1);
  assert.equal(page.nodes(node => node.type === "home-headlines-fixture")[0].props.authorized, false);
  assert.equal(page.nodes(node => node.props?.id === "home-registration-title").length, 1);
  assert.equal(page.locationRequests.length, 0);
  assert.equal(page.storage.has("shenxiang_member"), false);
});

test("home: registration appears immediately and does not grant location or membership", async (t) => {
  const page = mount("app/page.tsx", { showRegistration: true });
  t.after(() => page.dispose());
  assert.equal(text(page.nodes(node => node.type === "h2" && node.props.id === "home-registration-title")[0]), "输入注册码");
  assert.equal(page.nodes(node => node.props?.role === "dialog").length, 1);
  await page.advance(0);
  assert.equal(page.nodes(node => node.props?.role === "dialog").length, 1, "Consent must not stack behind the registration form");
  assert.equal(page.nodes(node => node.type === "main")[0].props.inert, true);
  page.action(page.nodes(node => node.type === "form")[0], "onSubmit", { preventDefault() {} });
  assert.equal(text(page.nodes(node => node.props?.role === "alert")[0]), "请先注册，注册码可通过好友分享获得。");
  page.action(page.nodes(node => node.props?.className === "news-registration-input")[0], "onChange", { target: { value: "friend-code" } });
  page.action(page.nodes(node => node.type === "form")[0], "onSubmit", { preventDefault() {} });
  assert.equal(page.nodes(node => node.props?.id === "home-registration-title").length, 1);
  assert.equal(page.nodes(node => node.props?.id === "home-consent-title").length, 0);
  assert.equal(text(page.nodes(node => node.props?.role === "alert")[0]), "请先注册，注册码可通过好友分享获得。");
  assert.equal(page.nodes(node => node.props?.className === "news-registration-input")[0].props.value, "friend-code");
  page.action(page.nodes(node => node.type === "form")[0], "onSubmit", { preventDefault() {} });
  await page.advance(3000);
  assert.equal(page.nodes(node => node.props?.role === "dialog").length, 1, "Repeated submissions keep the same dialog open");
  assert.equal(page.nodes(node => node.type === "main")[0].props.inert, true);
  assert.equal(page.locationRequests.length, 0, "Submitting a code is not location consent");
  assert.equal(page.storage.has("shenxiang_member"), false);
  assert.equal(page.storage.has("shenxiang_location_authorized_at"), false);
  assert.ok(![...page.storage.values()].includes("friend-code"), "The entry code is not persisted");
});

test("home: valid location consent does not suppress the per-visit registration form", async (t) => {
  const initialStorage = savedConsent();
  for (let visit = 0; visit < 2; visit++) {
    const page = mount("app/page.tsx", { showRegistration: true, initialStorage });
    t.after(() => page.dispose());
    await page.advance(0);
    assert.equal(page.nodes(node => node.props?.id === "home-registration-title").length, 1);
    page.action(page.nodes(node => node.props?.className === "news-registration-input")[0], "onChange", { target: { value: "friend-code" } });
    page.action(page.nodes(node => node.type === "form")[0], "onSubmit", { preventDefault() {} });
    assert.equal(page.nodes(node => node.props?.role === "dialog").length, 1);
    assert.equal(text(page.nodes(node => node.props?.role === "alert")[0]), "请先注册，注册码可通过好友分享获得。");
    assert.equal(page.nodes(node => node.type === "home-headlines-fixture")[0].props.authorized, true);
    assert.equal(page.locationRequests.length, 0);
  }
});
