import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function render(window) {
  const source = readFileSync(new URL("../app/BackToTop.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInContext(`(function(require,module,exports){${outputText}\n})`, vm.createContext(window ? { window } : {}))(name => {
    assert.equal(name, "react/jsx-runtime");
    return { jsx, jsxs: jsx };
  }, loaded, loaded.exports);
  return loaded.exports.default();
}

test("back-to-top renders safely on the server with an accessible non-submit icon", () => {
  const button = render();
  assert.equal(button.type, "button");
  assert.equal(button.props.type, "button");
  assert.equal(button.props["aria-label"], "返回顶部");
  assert.equal(button.props.children.props["aria-hidden"], "true");
});

for (const reducedMotion of [false, true]) {
  test(`back-to-top scrolls the page to zero, reduced motion: ${reducedMotion}`, () => {
    const calls = [];
    const button = render({
      matchMedia(query) { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reducedMotion }; },
      scrollTo(options) { calls.push(JSON.parse(JSON.stringify(options))); },
    });
    assert.equal(calls.length, 0);
    button.props.onClick();
    assert.deepEqual(calls, [{ top: 0, left: 0, behavior: reducedMotion ? "instant" : "smooth" }]);
  });
}
