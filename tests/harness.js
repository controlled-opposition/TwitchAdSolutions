// End-to-end harness for a built userscript (vaft/vaft.user.js by default).
//
// Runs the script in a mock page, constructs a Twitch worker so the script's Worker hook builds
// the injected blob, then runs that blob in a mock worker with a scripted network. Tests drive
// playlist requests through the hooked worker fetch and look at what comes back and what the
// worker posts to the page. GQL requests the worker relays to the page are answered here.
//
// The same harness runs any version of the script, which is how a refactor can be compared
// against the previous release: same scenario, same answers expected.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const noTimer = () => 0;

function makeStorage(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => items.set(k, String(v)),
        removeItem: (k) => items.delete(k),
    };
}

/**
 * Load the userscript into a mock page and return the worker blob it injects for a Twitch worker.
 * @param {string} scriptPath
 * @param {{ localStorage?: Record<string, string>, console?: object, setup?: (page: object) => void }} [options]
 *   `setup` runs against the page global before the script (e.g. to lock a property as another
 *   extension might).
 */
export function injectWorker(scriptPath, options = {}) {
    const blobs = [];
    class MockBlob {
        constructor(parts) {
            this.parts = parts;
        }
    }
    class PageURL extends URL {}
    PageURL.createObjectURL = (blob) => {
        blobs.push(blob);
        return 'blob:https://www.twitch.tv/injected-' + blobs.length;
    };
    PageURL.revokeObjectURL = () => {};
    // The Worker hook walks this class's prototype chain and rejects anything whose source
    // mentions the site name, so keep it out of this class body.
    class BaseWorker {
        constructor(url) {
            this.url = url;
            this.listeners = [];
        }
        addEventListener(type, fn) {
            this.listeners.push({ type, fn });
        }
        postMessage() {}
    }
    class PageXHR {
        open() {}
        overrideMimeType() {}
        send() {
            this.responseText = '/* twitch worker */';
        }
    }
    const page = vm.createContext({
        console: options.console || quietConsole,
        document: {
            location: { hostname: 'www.twitch.tv', pathname: '/testchan', href: 'https://www.twitch.tv/testchan' },
            readyState: 'loading',
            hidden: false,
            addEventListener() {},
            getElementsByTagName: () => [],
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        localStorage: makeStorage(options.localStorage),
        navigator: { platform: 'Linux x86_64', maxTouchPoints: 0 },
        URL: PageURL,
        Blob: MockBlob,
        Worker: BaseWorker,
        XMLHttpRequest: PageXHR,
        fetch: async () => {
            throw new Error('page fetch not mocked');
        },
        setTimeout: noTimer,
        setInterval: noTimer,
        clearTimeout() {},
        clearInterval() {},
    });
    page.window = page;
    page.frameElement = null;
    page.addEventListener = () => {};
    options.setup?.(page);
    vm.runInContext(readFileSync(scriptPath, 'utf8'), page, { filename: scriptPath });
    new page.Worker('blob:https://www.twitch.tv/twitch-worker');
    if (blobs.length !== 1) throw new Error('expected one injected worker blob, got ' + blobs.length);
    return blobs[0].parts.join('');
}

/**
 * Run an injected worker blob in a mock worker.
 * @param {string} blobSource
 * @param {{
 *   network: (url: string) => Promise<{ status?: number, body: string }> | { status?: number, body: string },
 *   gql?: (body: unknown) => { status?: number, body: string },
 *   twitchWorkerJs?: string,
 *   console?: object,
 *   now?: () => number,
 *   setup?: (worker: object) => void,
 * }} options `setup` runs against the worker global before the blob.
 */
export function startWorker(blobSource, options) {
    const posted = [];
    const messageHandlers = [];
    const requested = [];
    class WorkerXHR {
        open(_method, url) {
            this.url = url;
        }
        overrideMimeType() {}
        send() {
            this.responseText = options.twitchWorkerJs ?? 'var twitchWorkerLoaded = true;';
        }
    }
    const worker = vm.createContext({
        console: options.console || quietConsole,
        Response,
        Blob,
        URL,
        atob,
        XMLHttpRequest: WorkerXHR,
        setTimeout,
        clearTimeout,
        setInterval: noTimer,
        clearInterval() {},
        addEventListener(type, fn) {
            if (type === 'message') messageHandlers.push(fn);
        },
        fetch: async (url) => {
            requested.push(String(url));
            const r = await options.network(String(url));
            return new Response(r.body, { status: r.status ?? 200 });
        },
    });
    worker.self = worker;
    if (options.now) {
        vm.runInContext('Date.now = __now;', Object.assign(worker, { __now: options.now }));
    }
    const deliver = (data) => {
        for (const fn of messageHandlers) fn({ data });
    };
    // Plays the page's part: answers relayed GQL requests.
    worker.postMessage = (message) => {
        posted.push(message);
        if (message.key === 'FetchRequest') {
            const request = message.value;
            const answer = options.gql ? options.gql(JSON.parse(request.options.body)) : { status: 500, body: '' };
            setTimeout(() =>
                deliver({
                    key: 'FetchResponse',
                    value: {
                        id: request.id,
                        status: answer.status ?? 200,
                        statusText: '',
                        ok: (answer.status ?? 200) === 200,
                        redirected: false,
                        type: 'basic',
                        url: request.url,
                        headers: {},
                        body: answer.body,
                    },
                }),
            );
        }
    };
    options.setup?.(worker);
    vm.runInContext(blobSource, worker, { filename: 'worker-blob.js' });
    return {
        context: worker,
        posted,
        requested,
        deliver,
        /** Fetch through the hooked worker fetch; resolves to { status, body }. */
        async fetch(url) {
            const response = await worker.fetch(url);
            return { status: response.status, body: await response.text() };
        },
    };
}
