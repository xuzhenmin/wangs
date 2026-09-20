import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const content = `<video data-private-video-id="${id}" title="Synthetic fixture"></video>`;
const flush = () => new Promise(resolve => setImmediate(resolve));

// Exercise the installed production React DOM commit code, not an imitation of
// its prop comparison. The minimal DOM below never loads media or makes requests.
const reactDomPath = path.join(path.dirname(require.resolve('react-dom/package.json')), 'cjs/react-dom-client.production.js');
const reactDomSource = readFileSync(reactDomPath, 'utf8');
function reactFunction(name, nextName) {
  const start = reactDomSource.indexOf(`function ${name}(`), end = reactDomSource.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, 'Installed React DOM function boundaries changed; update this integration fixture.');
  return reactDomSource.slice(start, end);
}
const updateProperties = vm.runInNewContext(`${reactFunction('setProp', 'setPropOnCustomElement')}\n${reactFunction('updateProperties', 'isLikelyStaticResource')}\nupdateProperties;`);

class Element {
  constructor(tag = 'DIV', root = false) {
    this.tagName = tag; this.root = root; this.parentElement = null; this.children = []; this.attrs = new Map(); this.dataset = {}; this.style = {};
    this.listeners = new Map(); this.bounds = { top: 0, bottom: 400, height: 400 }; this.replacements = 0;
  }
  get isConnected() { return this.root || Boolean(this.parentElement?.isConnected); }
  append(child) { child.parentElement = this; this.children.push(child); }
  replaceWith(replacement) {
    if (!this.parentElement) return;
    const parent = this.parentElement, index = parent.children.indexOf(this);
    if (index < 0) return;
    parent.children[index] = replacement; replacement.parentElement = parent; replacement.bounds = { ...this.bounds }; this.parentElement = null; this.replacements++;
  }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  removeAttribute(name) { this.attrs.delete(name); }
  getBoundingClientRect() { return this.bounds; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector.startsWith('video[')) return all.filter(child => child instanceof Video && child.getAttribute('data-private-video-id'));
    if (selector === '*') return all;
    return all.filter(child => child instanceof Video || child.dataset.privateVideoHost || ['P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'IMG', 'A', 'HR'].includes(child.tagName));
  }
}
class Video extends Element {
  constructor() { super('VIDEO'); this.title = 'Synthetic fixture'; this.pauses = 0; this.src = ''; }
  pause() { this.pauses++; }
}
class Body extends Element {
  constructor() { super('DIV', true); this.writes = 0; }
  set innerHTML(value) {
    this.writes++;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const match of value.matchAll(/data-private-video-id="([a-f0-9-]+)"/g)) {
      const original = new Video(); original.setAttribute('data-private-video-id', match[1]); this.append(original);
    }
  }
}

function compile(relative, imports, globals = {}) {
  const source = readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, globals)(name => {
    if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
    return imports[name];
  }, loaded, loaded.exports);
  return loaded.exports.default;
}
function hookRuntime() {
  let cursor = 0, cleanups = 0;
  const values = [], effects = [];
  const effect = (callback, deps) => {
    const index = cursor++;
    if (!values[index] || deps.some((value, i) => value !== values[index].deps[i])) {
      const previous = values[index]; values[index] = { deps, cleanup: null };
      effects.push(() => { if (previous?.cleanup) { cleanups++; previous.cleanup(); } values[index].cleanup = callback(); });
    }
  };
  return {
    api: {
      useRef(initial) { const index = cursor++; return values[index] ||= { current: initial }; },
      useMemo(factory, deps) { const index = cursor++; if (!values[index] || deps.some((value, i) => value !== values[index].deps[i])) values[index] = { deps, value: factory() }; return values[index].value; },
      useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], update => { values[index] = typeof update === 'function' ? update(values[index]) : update; }]; },
      useEffect: effect, useLayoutEffect: effect,
    },
    begin() { cursor = 0; }, runEffects() { for (const run of effects.splice(0)) run(); },
    cleanupCount: () => cleanups,
    cleanup() { for (const value of values) if (value?.cleanup) { value.cleanup(); value.cleanup = null; } },
  };
}

async function harness(initialCollapsed = true) {
  const body = new Body(), viewport = new Element(), observers = [], portals = new Map();
  const disclosureHooks = hookRuntime(), embedHooks = hookRuntime();
  let previousProps = {}, embedProps, portalMounts = 0, portalUnmounts = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const Disclosure = compile('app/articles/[id]/ArticleContentDisclosure.tsx', {
    react: disclosureHooks.api, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../PrivateVideoEmbeds': { default: 'embeds-fixture' },
  }, {
    HTMLVideoElement: Video,
    ResizeObserver: class { constructor(callback) { this.callback = callback; this.active = false; observers.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  const Embeds = compile('app/PrivateVideoEmbeds.tsx', {
    react: embedHooks.api, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../lib/private-video-reference': { PRIVATE_VIDEO_ATTRIBUTE: 'data-private-video-id', isPrivateVideoId: value => [id, other].includes(value) },
    './PrivateVideoPlayer': { default: 'player-fixture' },
    'react-dom': { createPortal: (player, host, key) => ({ player, host, key }) },
  }, { queueMicrotask, document: { createElement: () => new Element() } });
  const renderEmbeds = () => {
    embedHooks.begin(); const output = Embeds(embedProps);
    const current = new Set(output.map(portal => portal.host));
    for (const [host] of portals) if (!current.has(host)) { portals.delete(host); portalUnmounts++; }
    for (const { player, host } of output) if (!portals.has(host)) {
      const video = new Video(); video.src = `/api/private-videos/${player.props.assetId}/manifest`; host.append(video); portals.set(host, video); portalMounts++;
    }
    embedHooks.runEffects();
  };
  const render = async (collapsed = initialCollapsed, nextContent = content) => {
    disclosureHooks.begin(); const tree = Disclosure({ collapsed, content: nextContent });
    tree.props.ref.current = viewport;
    const [htmlNode, embedsNode] = tree.props.children;
    htmlNode.props.ref.current = body;
    const nextProps = { dangerouslySetInnerHTML: htmlNode.props.dangerouslySetInnerHTML };
    updateProperties(body, 'div', previousProps, nextProps); previousProps = nextProps;
    disclosureHooks.runEffects(); embedProps = embedsNode.props;
    renderEmbeds(); await flush(); renderEmbeds();
    for (const observer of observers) if (observer.active) observer.callback();
    return { html: htmlNode.props.dangerouslySetInnerHTML };
  };
  await render();
  return { body, viewport, render, portals, mounts: () => portalMounts, unmounts: () => portalUnmounts, effectCleanups: embedHooks.cleanupCount,
    cleanup() { disclosureHooks.cleanup(); embedHooks.cleanup(); },
  };
}

test('installed React DOM rewrites identical HTML strings when their prop objects differ, detaching existing portal hosts', () => {
  const body = new Body(), previous = { dangerouslySetInnerHTML: { __html: content } };
  updateProperties(body, 'div', {}, previous);
  const host = new Element(); body.children[0].replaceWith(host);
  assert.equal(host.isConnected, true);
  updateProperties(body, 'div', previous, { dangerouslySetInnerHTML: { __html: content } });
  assert.equal(body.writes, 2); assert.equal(host.isConnected, false);
  assert.equal(body.children[0].getAttribute('data-private-video-id'), id);
});

test('same-content parent and disclosure renders preserve the mounted private player and protected source', async () => {
  const h = await harness(true);
  const [host, player] = [...h.portals.entries()][0];
  assert.equal(host.isConnected, true); assert.equal(h.mounts(), 1); assert.equal(h.body.writes, 1);
  for (let i = 0; i < 5; i++) await h.render(true);
  assert.equal(host.isConnected, true); assert.equal(h.portals.get(host), player);
  assert.equal(player.src, `/api/private-videos/${id}/manifest`);
  assert.equal(h.body.writes, 1); assert.equal(h.mounts(), 1); assert.equal(h.effectCleanups(), 0);
  await h.render(false); await h.render(true); await h.render(false);
  assert.equal(host.isConnected, true); assert.equal(h.portals.get(host), player);
  assert.equal(h.body.writes, 1); assert.equal(h.mounts(), 1); assert.equal(h.unmounts(), 0);
  h.cleanup();
});

test('folded controls remain inert and paused, and expansion restores accessibility without remounting the video', async () => {
  const h = await harness(true), [host, player] = [...h.portals.entries()][0];
  assert.equal(h.viewport.style.maxHeight, '100px');
  assert.equal(host.getAttribute('inert'), ''); assert.equal(host.getAttribute('aria-hidden'), 'true');
  assert.equal(player.getAttribute('inert'), ''); assert.ok(player.pauses > 0);
  await h.render(false);
  assert.equal(h.viewport.style.maxHeight, '');
  assert.equal(host.getAttribute('inert'), null); assert.equal(host.getAttribute('aria-hidden'), null);
  assert.equal(player.getAttribute('inert'), null); assert.equal(player.getAttribute('aria-hidden'), null);
  assert.equal(player.isConnected, true); assert.equal(h.mounts(), 1);
  h.cleanup();
});

test('changing real article HTML replaces and cleans the old portal exactly once and mounts the new resource', async () => {
  const h = await harness(false), [oldHost, oldPlayer] = [...h.portals.entries()][0];
  const updated = content.replace(id, other);
  await h.render(false, updated);
  assert.equal(h.body.writes, 2); assert.equal(oldHost.isConnected, false); assert.equal(oldPlayer.isConnected, false);
  assert.equal(h.effectCleanups(), 1); assert.equal(h.unmounts(), 1); assert.equal(h.mounts(), 2);
  const [host, player] = [...h.portals.entries()][0];
  assert.equal(host.isConnected, true); assert.equal(player.src, `/api/private-videos/${other}/manifest`);
  await h.render(false, updated);
  assert.equal(h.body.writes, 2); assert.equal(h.effectCleanups(), 1); assert.equal(h.mounts(), 2);
  h.cleanup();
});
