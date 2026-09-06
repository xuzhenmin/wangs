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
} = {}) {
  const hooks = [];
  const timers = new Map();
  const storage = new Map(initialStorage);
  const locationRequests = [];
  const networkRequests = [];
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
    "next/navigation": { usePathname: () => "/" },
    "../lib/location-consent-browser": consent,
    "../../../lib/location-consent-browser": consent,
    "./ArticleContentDisclosure": { default: "article-content-disclosure-fixture" },
    "./WechatShare": { default: "wechat-share-fixture" },
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
    advance, settle, nodes, storage, locationRequests, networkRequests, permissionQueries,
    permission, browser, browserDocument,
    disclosure: () => nodes((node) => node.type === "article-content-disclosure-fixture")[0]?.props,
    message: consent.LOCATION_PERMISSION_DENIED_MESSAGE,
    action(node, name = "onClick", event) { node.props[name](event); render(); },
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
  ["home", "app/page.tsx", 0, "获取同城黑料"],
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

const consentTtl = 100 * 24 * 60 * 60 * 1000;
const authorizedAtKey = "shenxiang_location_authorized_at";
const expiryKey = "shenxiang_location_consent_expires_at";
function savedConsent(at = Date.now() - 60000) {
  return [[authorizedAtKey, String(at)], [expiryKey, String(at + consentTtl)], ["shenxiang_member", "active"]];
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

  test(`${filename}: granted revisits still refresh immediately and after 30 minutes without renewing consent`, async (t) => {
    const receipt = savedConsent();
    const page = mount(filename, { initialStorage: receipt, permissionState: "granted" });
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
  assert.ok(articleButton(page, "重新获取位置"));
  assert.equal(page.locationRequests.length, 1);
  assert.equal(page.networkRequests.length, 0);
  assert.equal(page.storage.has("shenxiang_location"), false);
  assert.ok(page.nodes((node) => node.props?.role === "status" && /允许位置访问后/.test(text(node))).length);
  assert.equal(page.nodes((node) => /1\/3|2\/3|一半|三分|50%/.test(text(node))).length, 0);

  page.action(articleButton(page, "重新获取位置"));
  assert.equal(page.locationRequests.length, 2, "Only the explicit inline retry requests location");
  page.fail(1);
  await page.advance(60000);
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0, "An inline failure must not reopen the blocking dialog");
  assert.equal(text(page.nodes((node) => node.props?.id === "article-location-inline-error")[0]), page.message);
  assert.equal(page.locationRequests.length, 2);
  assert.equal(page.networkRequests.length, 0);
});

test("article: permission grants require manual expansion and revocation refolds without collecting location", async (t) => {
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
  assert.equal(page.disclosure().collapsed, false);
  assert.equal(page.nodes((node) => node.props?.role === "dialog").length, 0);
  assert.equal(articleButton(page, "重新获取位置"), undefined);
  assert.equal(page.permission.listenerCount("change"), 1, "Permission monitoring remains active to detect later revocation");
  await page.permissionChange("denied");
  assert.equal(page.disclosure().collapsed, true);
  assert.ok(articleButton(page, "重新获取位置"));
  await page.permissionChange("granted");
  assert.equal(page.disclosure().collapsed, true);
  assert.ok(articleButton(page, "展开"));
  await page.permissionChange("prompt");
  assert.equal(page.disclosure().collapsed, true);
  assert.equal(page.locationRequests.length, 1);
  assert.equal(page.networkRequests.length, 0);
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
    assert.equal(page.disclosure().collapsed, false);
    assert.ok(page.permissionQueries.length > initialQueries);
    assert.equal(page.permission.listenerCount("change"), 1, "Repeated queries must not accumulate listeners");
    assert.equal(page.locationRequests.length, 1);
    assert.equal(page.networkRequests.length, 0);
  });
}

for (const [label, options] of [
  ["unsupported Permissions API", { permissionsSupported: false }],
  ["rejected permission query", { permissionQuery: async () => { throw new Error("fixture unsupported query"); } }],
]) {
  test(`article: ${label} allows manual expansion after location success without waiting for storage`, async (t) => {
    const page = mount("app/articles/[id]/ArticleLocationGate.tsx", options);
    t.after(() => page.dispose());
    await collapseArticle(page);
    await page.focus();
    assert.equal(page.disclosure().collapsed, true);
    assert.equal(page.locationRequests.length, 1);
    page.action(articleButton(page, "重新获取位置"));
    assert.equal(page.locationRequests.length, 2);
    const pending = page.succeed();
    assert.equal(page.disclosure().collapsed, true, "Location success alone must not expand the article");
    assert.ok(articleButton(page, "展开"));
    assert.equal(articleButton(page, "展开").props.disabled, false);
    assert.equal(text(articleButton(page, "展开")), "", "The expand button must be icon-only with an accessible name");
    assert.equal(articleButton(page, "展开").props.children.type, "svg");
    assert.equal(articleButton(page, "展开").props.children.props["aria-hidden"], "true");
    page.action(articleButton(page, "展开"));
    assert.equal(page.disclosure().collapsed, false, "The explicit expand action shows the remaining content");
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
