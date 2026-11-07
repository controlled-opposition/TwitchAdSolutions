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

// --tsconfig-raw={}: don't let tsconfig's `strict` add "use strict". The script has always run
// in sloppy mode, where e.g. assigning to a fetch/open another extension made read-only fails
// quietly; in strict mode it throws and takes down the hook (in the worker, Twitch's player too).
export const esbuildArgs = [
    '--bundle',
    '--format=iife',
    '--target=es2022',
    '--charset=utf8',
    '--log-level=warning',
    '--tsconfig-raw={}',
];

function esbuildRun(entry, extraArgs = []) {
    return execFileSync(esbuild, [entry, ...esbuildArgs, ...extraArgs], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
}

export function build() {
    const worker = esbuildRun('src/worker/index.ts');
    const header = readFileSync(join(root, 'src', 'meta.js'), 'utf8').trimEnd();
    const page = esbuildRun('src/page/index.ts', [`--banner:js=${header}`]);
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
