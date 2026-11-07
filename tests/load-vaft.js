// Loads functions straight out of vaft/vaft.user.js so tests and benchmarks exercise the
// shipped code instead of hand-copied versions that drift.
//
// Each requested top-level declaration (function or const/let) is located with acorn,
// sliced out of the source, and evaluated in a fresh vm context. declareOptions(globalThis)
// runs first, so the shared config/state globals (AdSignifiers, V2API, AdSegmentCache, ...)
// live on the returned context exactly as they do on `self` inside the worker blob.
// Tests read and write them as properties: `vaft.V2API = true`.
//
// The extracted functions are the same ones vaft serializes into its worker via
// .toString(), so they must not depend on anything outside the declarations loaded here;
// a missing dependency surfaces as a ReferenceError in the test, as it would in the worker.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');

const SCRIPT_PATH = path.join(__dirname, '..', 'vaft', 'vaft.user.js');

const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

// Collect every FunctionDeclaration and VariableDeclaration in the file by name.
function indexDeclarations(ast) {
    const found = new Map();
    const add = (name, node) => {
        if (!found.has(name)) found.set(name, []);
        found.get(name).push(node);
    };
    const visit = (node) => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'FunctionDeclaration' && node.id) {
            add(node.id.name, node);
        } else if (node.type === 'VariableDeclaration') {
            for (const d of node.declarations) {
                if (d.id.type === 'Identifier') add(d.id.name, { declaration: node, declarator: d });
            }
        }
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value.type === 'string') visit(value);
        }
    };
    visit(ast);
    return found;
}

/**
 * @param {string[]} names top-level function or variable names to load
 * @param {{ console?: object, globals?: object }} [options] console used by the loaded code
 *   (silent by default); extra globals (fetch, Response, ...) to provide. `self` and `window`
 *   always point at the context itself, as in the worker / page.
 * @returns {object} vm context holding the loaded functions and declareOptions() globals
 */
function loadVaft(names, options = {}) {
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
    const declarations = indexDeclarations(ast);

    const pick = (name) => {
        const matches = declarations.get(name) || [];
        if (matches.length !== 1) {
            throw new Error(`load-vaft: expected exactly one declaration of '${name}' in vaft.user.js, found ${matches.length}`);
        }
        const match = matches[0];
        if (match.type === 'FunctionDeclaration') {
            return source.slice(match.start, match.end);
        }
        // const/let → var so the binding lands on the context object and tests can reach it.
        const { declaration, declarator } = match;
        if (declaration.declarations.length !== 1) {
            throw new Error(`load-vaft: '${name}' shares a declaration with other variables; split it to load it`);
        }
        return 'var ' + source.slice(declarator.start, declarator.end) + ';';
    };

    const context = vm.createContext({ console: options.console || quietConsole, ...(options.globals || {}) });
    context.self = context;
    context.window = context;
    const wanted = ['declareOptions', ...names.filter((n) => n !== 'declareOptions')];
    vm.runInContext(wanted.map(pick).join('\n'), context, { filename: SCRIPT_PATH });
    vm.runInContext('declareOptions(globalThis);', context);
    return context;
}

module.exports = { loadVaft, SCRIPT_PATH };
