// Builds vaft/vaft.user.js from src/ with esbuild (the CLI, from the Nix dev shell or npm).
//
//   node scripts/build.js           write vaft/vaft.user.js
//   node scripts/build.js --check   fail if vaft/vaft.user.js is not what the sources build to
//
// Two bundles:
//   1. src/worker/index.ts -> the worker, one self-contained IIFE.
//   2. src/page/index.ts -> the userscript, with src/meta.js as its header. The worker bundle is
//      spliced in as the body of runWorker() (src/page/worker-bundle.ts), which the page starts
//      workers from via .toString(). Splicing text after esbuild keeps the worker code exactly as
//      built: bundled into the page, esbuild would rename worker symbols that clash with page ones.
// Output is unminified so stack traces in users' consoles stay readable.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = process.env.ESBUILD || 'esbuild';
const check = process.argv.includes('--check');
const target = join(root, 'vaft', 'vaft.user.js');
// The placeholder call's whole line, indentation included. The worker code goes in unindented:
// re-indenting would change any multi-line template literal in it.
const PLACEHOLDER = /^[ \t]*__VAFT_WORKER_BUNDLE__\(\);\n/m;

// The output is strict mode: alwaysStrict makes esbuild emit "use strict". Hooks are installed
// through installHook() (src/shared/hook.ts), so a property another extension made read-only is
// logged and handled instead of throwing. The raw tsconfig also keeps esbuild from reading
// tsconfig.json, so the output doesn't shift with type-checking settings.
export const esbuildArgs = [
    '--bundle',
    '--format=iife',
    '--target=es2022',
    '--charset=utf8',
    '--log-level=warning',
    '--tsconfig-raw={"compilerOptions":{"alwaysStrict":true}}',
];

// esbuild puts "use strict" above the IIFE, at the top of the file. Move it to the first line of
// the IIFE body so it holds wherever the code ends up: a userscript manager that puts its own
// code before the script would turn a file-level directive into a no-op string, and the worker
// bundle is spliced into runWorker() and shipped as that function's source text.
const FILE_DIRECTIVE = /^"use strict";\n\(\(\) => \{\n/m;
function strictIife(code, name) {
    if (!FILE_DIRECTIVE.test(code)) {
        throw new Error(`${name} bundle: expected esbuild's "use strict" directive above the IIFE`);
    }
    return code.replace(FILE_DIRECTIVE, '(() => {\n  "use strict";\n');
}

function esbuildRun(entry, extraArgs = []) {
    return execFileSync(esbuild, [entry, ...esbuildArgs, ...extraArgs], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
}

export function build() {
    const worker = strictIife(esbuildRun('src/worker/index.ts'), 'worker');
    const header = readFileSync(join(root, 'src', 'meta.js'), 'utf8').trimEnd();
    const page = strictIife(esbuildRun('src/page/index.ts', [`--banner:js=${header}`]), 'page');
    const parts = page.split(PLACEHOLDER);
    if (parts.length !== 2) {
        throw new Error(`expected one __VAFT_WORKER_BUNDLE__() call in the page bundle, found ${parts.length - 1}`);
    }
    return parts[0] + worker + parts[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const output = build();
    if (check) {
        let current = '';
        try {
            current = readFileSync(target, 'utf8');
        } catch {}
        if (current !== output) {
            console.error('vaft/vaft.user.js is out of date with src/. Run: node scripts/build.js');
            process.exit(1);
        }
        console.log('vaft/vaft.user.js is up to date.');
    } else {
        writeFileSync(target, output);
        console.log('Wrote vaft/vaft.user.js (' + output.split('\n').length + ' lines).');
    }
}
