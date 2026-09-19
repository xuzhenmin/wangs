import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Each node:test file runs in its own process. Compile actual server modules,
// retaining dependency behavior rather than replacing imports with test copies.
export function loadTs(relative, parent) {
  const require = createRequire(parent);
  require.extensions['.ts'] ||= (module, filename) => {
    const source = readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }, fileName: filename }).outputText;
    module._compile(compiled, filename);
  };
  return require(fileURLToPath(new URL(relative, parent)));
}
