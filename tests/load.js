// Loads src/ modules for tests and benchmarks: bundles them with esbuild (same flags as the real
// build) and evaluates the bundle in a fresh vm context, so every call gets its own module
// state (state.StreamInfos, AdSegmentCache, ...) and its own globals.
//
//   const vaft = loadModules(['src/worker/ads.ts', 'src/worker/state.ts'], { globals: { fetch } });
//   vaft.stripAdSegments(...); vaft.state.V2API = true; vaft.context.fetch(...)
//
// The returned object holds every export of the listed modules (live bindings), plus `context`:
// the vm global, where `self` and `window` point at the context itself.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { esbuildArgs } from '../scripts/build.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

/**
 * @param {string[]} modules paths relative to the repo root
 * @param {{ console?: object, globals?: object }} [options] console for the loaded code (silent by
 *   default) and extra globals (fetch, Response, postMessage, ...)
 */
export function loadModules(modules, options = {}) {
    const entry = modules.map((m) => `export * from ${JSON.stringify(resolve(ROOT, m))};`).join('\n');
    const code = execFileSync(
        process.env.ESBUILD || 'esbuild',
        [...esbuildArgs, '--global-name=__vaftExports', '--sourcefile=test-entry.ts', '--loader=ts'],
        { cwd: ROOT, input: entry, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const context = vm.createContext({ console: options.console || quietConsole, ...(options.globals || {}) });
    context.self = context;
    context.window = context;
    vm.runInContext(code, context, { filename: 'test-bundle.js' });
    return Object.assign(Object.create(context.__vaftExports), { context });
}
