import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("article view tracker counts mounted pages once and ignores reporting failures", async () => {
  const calls = [];
  const effects = [];
  const ref = { current: null };
  let event = 0;
  const context = vm.createContext({
    crypto: { randomUUID: () => `event-${++event}` },
    fetch: (...args) => { calls.push(args); return Promise.reject(new Error("fixture network failure")); },
  });
  const source = readFileSync(new URL("../app/articles/[id]/ArticleViewTracker.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loadedModule = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${outputText}\n})`, context)(name => {
    assert.equal(name, "react");
    return { useRef: () => ref, useEffect: callback => effects.push(callback) };
  }, loadedModule, loadedModule.exports);
  const Tracker = loadedModule.exports.default;
  assert.equal(Tracker({ articleId: "first" }), null);
  assert.equal(calls.length, 0, "No reports during rendering/prefetching");
  effects[0](); effects[0]();
  await Promise.resolve();
  assert.equal(calls.length, 1, "Strict Mode's repeated effect must not double count");
  Tracker({ articleId: "second" }); effects.at(-1)();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "/api/articles/first/view");
  assert.equal(calls[1][0], "/api/articles/second/view");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].keepalive, true);
  assert.deepEqual(Object.keys(JSON.parse(calls[0][1].body)), ["eventId"], "Never transmit location or device information");
});
