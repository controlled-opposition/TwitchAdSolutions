#!/usr/bin/env node
// vaftctl: drive the built vaft userscript inside a real Google Chrome on live twitch.tv, over CDP.
// Zero npm dependencies (Node >= 22 for the global WebSocket). Run `vaftctl.mjs help` for usage.
//
// State lives in $VAFT_VERIFY_DIR (default <repo>/.verify, gitignored):
//   state.json        the Chrome this checkout launched (pid, port, profile)
//   chrome-profile/   its throwaway profile (removed by teardown)
//   chrome.log        its stderr (removed by teardown)
//   evidence/<stamp>-<name>/   one dir per drive (kept by teardown)
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DIR = resolve(process.env.VAFT_VERIFY_DIR || join(REPO, '.verify'));
const STATE = join(DIR, 'state.json');
const PROFILE = join(DIR, 'chrome-profile');
const SCRIPT = join(REPO, 'vaft/vaft.user.js');
const CHROME = process.env.VAFT_CHROME || 'google-chrome';
const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch web client's public Client-ID

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => {
    console.error('vaftctl: ' + msg);
    process.exit(1);
};
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const FLAGS = new Set(['headful', 'n', 'channel', 'url', 'seconds', 'name', 'ls', 'at', 'shots', 'no-inject', 'network']);
const BOOL_FLAGS = new Set(['headful', 'no-inject', 'network']);
function parseArgs(argv) {
    const out = { _: [], ls: [], at: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            out._.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        const key = eq > 0 && !a.startsWith('--ls') && !a.startsWith('--at') ? a.slice(2, eq) : a.slice(2);
        if (!FLAGS.has(key)) die('unknown flag --' + key + ' (a quoted "--flag value" is one argument)');
        const val = eq > 0 && key !== a.slice(2) ? a.slice(eq + 1) : BOOL_FLAGS.has(key) ? true : argv[++i];
        if (val === undefined) die('--' + key + ' needs a value');
        if (key === 'ls') out.ls.push(val);
        else if (key === 'at') out.at.push(val);
        else out[key] = val;
    }
    return out;
}

// ---------------------------------------------------------------- CDP

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.handlers = [];
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve: res, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message + ' (' + msg.id + ')')) : res(msg.result);
            } else if (msg.method) {
                for (const h of this.handlers) h(msg);
            }
        });
    }
    static async connect(url) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', () => rej(new Error('CDP connect failed: ' + url)), { once: true });
        });
        return new Cdp(ws);
    }
    send(method, params = {}, sessionId) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
        return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
    }
    on(fn) {
        this.handlers.push(fn);
    }
    close() {
        this.ws.close();
    }
}

async function browserWs(st) {
    const r = await fetch('http://127.0.0.1:' + st.port + '/json/version');
    return (await r.json()).webSocketDebuggerUrl;
}

// ---------------------------------------------------------------- launch / teardown

async function launch(opts) {
    const st = readState();
    if (st && alive(st.pid)) die('already running (pid ' + st.pid + ', port ' + st.port + '). Run teardown first.');
    mkdirSync(DIR, { recursive: true });
    rmSync(PROFILE, { recursive: true, force: true });
    mkdirSync(PROFILE, { recursive: true });
    const version = execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).match(/(\d+)\.\d+\.\d+\.\d+/);
    if (!version) die('cannot read Chrome version from ' + CHROME);
    // Headless Chrome advertises "HeadlessChrome" in its UA; present as the same desktop Chrome a user runs.
    const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version[1]}.0.0.0 Safari/537.36`;
    const args = [
        opts.headful ? null : '--headless=new',
        '--remote-debugging-port=0',
        '--user-data-dir=' + PROFILE,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--enable-unsafe-extension-debugging', // lets drive load its injector via CDP Extensions.loadUnpacked
        '--window-size=1280,800',
        '--user-agent=' + ua,
        'about:blank',
    ].filter(Boolean);
    const logFd = openSync(join(DIR, 'chrome.log'), 'w');
    const child = spawn(CHROME, args, { detached: true, stdio: ['ignore', logFd, logFd] });
    child.unref();
    const portFile = join(PROFILE, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
        await sleep(100);
        if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || null;
        if (!alive(child.pid)) die('Chrome exited during launch; see ' + join(DIR, 'chrome.log'));
    }
    if (!port) die('Chrome never wrote DevToolsActivePort; see ' + join(DIR, 'chrome.log'));
    const state = { pid: child.pid, port, profile: PROFILE, headful: !!opts.headful, ua, startedAt: new Date().toISOString() };
    writeFileSync(STATE, JSON.stringify(state, null, 2));
    // Ready = the browser endpoint answers CDP, not just that the port file exists.
    const cdp = await Cdp.connect(await browserWs(state));
    const v = await cdp.send('Browser.getVersion');
    cdp.close();
    console.log(`READY pid=${child.pid} port=${port} browser=${v.product} dir=${DIR}`);
}

async function teardown() {
    const st = readState();
    if (!st) {
        console.log('nothing to tear down (no ' + STATE + ')');
    } else {
        if (alive(st.pid)) {
            // Launched detached, so pid is its own process group: this kills exactly the Chrome we started.
            try {
                process.kill(-st.pid, 'SIGTERM');
            } catch {}
            for (let i = 0; i < 50 && alive(st.pid); i++) await sleep(100);
            if (alive(st.pid)) {
                try {
                    process.kill(-st.pid, 'SIGKILL');
                } catch {}
            }
        }
        console.log('stopped pid ' + st.pid);
    }
    rmSync(PROFILE, { recursive: true, force: true });
    for (const d of existsSync(DIR) ? readdirSync(DIR) : []) if (d.startsWith('ext-')) rmSync(join(DIR, d), { recursive: true, force: true });
    rmSync(STATE, { force: true });
    rmSync(join(DIR, 'chrome.log'), { force: true });
    console.log('evidence kept in ' + join(DIR, 'evidence'));
}

// ---------------------------------------------------------------- doctor

async function doctor() {
    let ok = true;
    const check = (label, pass, detail) => {
        if (!pass) ok = false;
        console.log((pass ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
    };
    const st = readState();
    check('state file', !!st, st ? STATE : 'run launch first');
    if (st) {
        check('chrome pid ' + st.pid + ' alive', alive(st.pid));
        let product = null;
        try {
            const cdp = await Cdp.connect(await browserWs(st));
            product = (await cdp.send('Browser.getVersion')).product;
            cdp.close();
        } catch (e) {
            product = null;
        }
        check('CDP on port ' + st.port, !!product, product || 'no answer');
        // The port is ours only if the answering Chrome uses our profile dir.
        let ownsPort = false;
        try {
            const cmd = readFileSync('/proc/' + st.pid + '/cmdline', 'utf8');
            ownsPort = cmd.includes('--user-data-dir=' + st.profile);
        } catch {}
        check('pid runs our profile', ownsPort, st.profile);
    }
    let built = false;
    try {
        execFileSync('node', [join(REPO, 'scripts/build.js'), '--check'], { cwd: REPO, stdio: 'pipe' });
        built = true;
    } catch {}
    check('vaft/vaft.user.js matches src/', built, built ? '' : 'run node scripts/build.js');
    const src = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf8') : '';
    const ver = src.match(/@version\s+(\S+)/)?.[1];
    const internal = src.match(/ourTwitchAdSolutionsVersion = (\d+)/)?.[1];
    check('built script version', !!ver, `@version ${ver}, ourTwitchAdSolutionsVersion ${internal}`);
    let twitch = 0;
    try {
        twitch = (await fetch('https://www.twitch.tv/')).status;
    } catch {}
    check('twitch.tv reachable', twitch > 0 && twitch < 500, 'HTTP ' + twitch);
    console.log(ok ? 'DOCTOR OK' : 'DOCTOR FAILED');
    process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- channel picker

async function liveChannels(n) {
    const query = `query { streams(first: ${n}, options: { sort: VIEWER_COUNT }) { edges { node { viewersCount broadcaster { login } } } } }`;
    const r = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': PUBLIC_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    const j = await r.json();
    const edges = j?.data?.streams?.edges;
    if (!edges) throw new Error('GQL streams query failed: ' + JSON.stringify(j).slice(0, 300));
    return edges.map((e) => ({ login: e.node.broadcaster.login, viewers: e.node.viewersCount }));
}

// ---------------------------------------------------------------- drive

// Runs before the userscript in every document: seeds this drive's localStorage settings on twitch.tv.
function prelude(settings) {
    return `(() => { try {
        if (!/(^|\\.)twitch\\.tv$/.test(location.hostname)) return;
        // What existed when document-start scripts ran (userscript managers differ here; see features/settings.md).
        window.__vaftVerifyDocStart = { documentElement: !!document.documentElement, head: !!document.head };
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('twitchAdSolutions_')) localStorage.removeItem(k);
        }
        const s = ${JSON.stringify(settings)};
        for (const k in s) localStorage.setItem(k, s[k]);
    } catch (e) {} })();`;
}

const SAMPLE_JS = `(() => {
    const v = document.querySelector('.video-player video') || document.querySelector('video');
    const o = document.querySelector('.tas-adblock-overlay');
    const b = v && v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null;
    return JSON.stringify({
        url: location.pathname,
        video: v ? { t: v.currentTime, paused: v.paused, readyState: v.readyState, muted: v.muted,
            w: v.videoWidth, h: v.videoHeight, bufferedEnd: b, rate: v.playbackRate, src: (v.currentSrc || '').slice(0, 40) } : null,
        videos: document.getElementsByTagName('video').length,
        banner: o ? { display: o.style.display, visible: getComputedStyle(o).display !== 'none', text: o.textContent } : null,
        sdaHidden: [...document.querySelectorAll('[data-test-selector="sda-wrapper"]')].map(e => e.style.getPropertyValue('display')),
        docStart: window.__vaftVerifyDocStart || null,
        vaftVersion: typeof window.twitchAdSolutionsVersion === 'undefined' ? null : window.twitchAdSolutionsVersion,
        playerError: ((document.querySelector('.video-player') || {}).innerText || '').match(/Error #\\d+/)?.[0] || null,
        gate: !!document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"], [data-a-target="player-overlay-mature-accept"]'),
    });
})()`;

// Log lines that mark a step of an ad break, from detection to the end-of-break player action.
const MILESTONES = new RegExp(
    [
        'Ad detected',
        'Blocking (\\w+ )?ads',
        'Autoplay backup committed',
        'No ad-free backup',
        'All segments stripped',
        'Early reload',
        'Finished blocking ads',
        'End-of-break',
        'CSAI-only ad break',
        'Reloading Twitch player',
        'Drift correction',
        'SimulatedAdsDepth',
        'Hidden ',
        'CONFLICT',
        'vaft skipped',
        'falling back to unmodified worker',
        'Could not hook',
        'Player stopping playback',
    ].join('|'),
);
const ranges = (secs) => {
    const out = [];
    for (const s of secs) {
        const last = out[out.length - 1];
        if (last && last[1] === s - 1) last[1] = s;
        else out.push([s, s]);
    }
    return out.map(([a, b]) => (a === b ? String(a) : a + '-' + b)).join(',');
};

async function drive(opts) {
    const st = readState();
    if (!st || !alive(st.pid)) die('no running Chrome; run launch first');
    if (!existsSync(SCRIPT)) die('missing ' + SCRIPT + '; run node scripts/build.js');
    let channel = opts.channel;
    if (!opts.url && !channel) {
        const list = await liveChannels(5);
        channel = list[0].login;
        console.log('picked live channel ' + channel + ' (' + list[0].viewers + ' viewers)');
    }
    const url = opts.url || 'https://www.twitch.tv/' + channel;
    const seconds = Number(opts.seconds || 30);
    const name = String(opts.name || 'drive').replace(/[^\w.-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = join(DIR, 'evidence', stamp + '-' + name);
    mkdirSync(out, { recursive: true });
    const settings = {};
    for (const kv of opts.ls) {
        const eq = String(kv).indexOf('=');
        if (eq < 1) die('--ls needs key=value, got ' + kv);
        const k = kv.slice(0, eq);
        settings[k.startsWith('twitchAdSolutions_') ? k : 'twitchAdSolutions_' + k] = kv.slice(eq + 1);
    }
    // --at "<sec>:<js>" evaluates page JS at that time. Shorthand: "<sec>:simulateAds(1)".
    const actions = opts.at
        .map((a) => {
            const c = String(a).indexOf(':');
            const t = c > 0 ? Number(String(a).slice(0, c)) : NaN;
            if (!Number.isFinite(t)) die(`--at needs "<seconds>:<js>", got ${JSON.stringify(a)}`);
            return { t, js: String(a).slice(c + 1) };
        })
        .sort((a, b) => a.t - b.t);
    const shotTimes = String(opts.shots || [5, Math.round(seconds / 2), seconds - 1].join(','))
        .split(',')
        .map(Number);
    writeFileSync(
        join(out, 'run.json'),
        JSON.stringify({ argv: process.argv.slice(2), url, seconds, settings, actions, inject: !opts['no-inject'], ua: st.ua }, null, 2),
    );

    const logPath = join(out, 'console.log');
    writeFileSync(logPath, '');
    const t0 = Date.now();
    const rel = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(7);
    const log = (src, text) => appendFileSync(logPath, `${rel()} [${src}] ${text}\n`);

    // --network: playlist (usher/m3u8) and access-token traffic per session, in network.log and console.log.
    const netIds = new Set();
    const isMediaUrl = (u) => /usher\.ttvnw\.net|\.m3u8|ttvnw\.net\/v1\/playlist|gql\.twitch\.tv/.test(u);
    const netLog = (src, text) => {
        netIds.add(text.split(' ')[1]);
        log(src, '[net] ' + text);
    };
    const cdp = await Cdp.connect(await browserWs(st));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionLabel = new Map([[page, 'page']]);
    cdp.on(async (msg) => {
        const label = sessionLabel.get(msg.sessionId);
        if (msg.method === 'Runtime.consoleAPICalled' && label) {
            const text = msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
            log(label, text);
        } else if (msg.method === 'Network.requestWillBeSent' && label && isMediaUrl(msg.params.request.url)) {
            netLog(label, 'REQ ' + msg.params.requestId + ' ' + msg.params.request.url.split('?')[0]);
        } else if (msg.method === 'Network.responseReceived' && label && isMediaUrl(msg.params.response.url)) {
            netLog(label, 'RES ' + msg.params.requestId + ' ' + msg.params.response.status + ' ' + msg.params.response.url.split('?')[0]);
        } else if (msg.method === 'Network.loadingFailed' && label && netIds.has(msg.params.requestId)) {
            netLog(label, 'FAIL ' + msg.params.requestId + ' ' + msg.params.errorText + (msg.params.canceled ? ' (canceled)' : ''));
        } else if (msg.method === 'Runtime.exceptionThrown' && label) {
            const d = msg.params.exceptionDetails;
            log(label, 'EXCEPTION ' + (d.exception?.description || d.text).split('\n')[0]);
        } else if (msg.method === 'Target.attachedToTarget') {
            const { sessionId, targetInfo } = msg.params;
            const kind = targetInfo.type === 'worker' ? 'worker' : targetInfo.type + ':' + (targetInfo.url || '').slice(0, 60);
            sessionLabel.set(sessionId, kind);
            log('cdp', 'attached ' + targetInfo.type + ' ' + (targetInfo.url || '').slice(0, 80));
            try {
                await cdp.send('Runtime.enable', {}, sessionId);
                if (opts.network) await cdp.send('Network.enable', {}, sessionId).catch(() => {});
                await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
            } catch {}
            cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        }
    });
    await cdp.send('Page.enable', {}, page);
    await cdp.send('Runtime.enable', {}, page);
    if (opts.network) await cdp.send('Network.enable', {}, page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page);
    // Workers (Twitch's video worker) pause until we have enabled Runtime on them, so no early log is lost.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page);
    // Inject the way an MV3 userscript manager does for @run-at document-start + @grant none: a MAIN-world
    // content script at document_start in every twitch.tv frame. (Page.addScriptToEvaluateOnNewDocument runs
    // earlier, before <html> exists, which no manager does.) The settings prelude runs first in the same file.
    const extDir = join(DIR, 'ext-' + stamp);
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
        join(extDir, 'manifest.json'),
        JSON.stringify({
            manifest_version: 3,
            name: 'vaft verify injector',
            version: '1',
            content_scripts: [
                { matches: ['*://*.twitch.tv/*'], js: ['inject.js'], run_at: 'document_start', world: 'MAIN', all_frames: true },
            ],
        }),
    );
    writeFileSync(join(extDir, 'inject.js'), prelude(settings) + '\n' + (opts['no-inject'] ? '' : readFileSync(SCRIPT, 'utf8')));
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
    log('cdp', 'loaded injector extension ' + extId + (opts['no-inject'] ? ' (settings only, no vaft)' : ''));
    log('cdp', 'navigate ' + url);
    await cdp.send('Page.navigate', { url }, page);

    const evalPage = async (js) => {
        const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, page);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    };
    const samples = [];
    const shotsTaken = new Set();
    let actionIdx = 0;
    for (let sec = 1; sec <= seconds; sec++) {
        await sleep(Math.max(0, t0 + sec * 1000 - Date.now()));
        while (actionIdx < actions.length && actions[actionIdx].t <= sec) {
            const a = actions[actionIdx++];
            try {
                const v = await evalPage(a.js);
                log('action', `${a.js} => ${JSON.stringify(v)}`);
            } catch (e) {
                log('action', `${a.js} THREW ${e.message}`);
            }
        }
        try {
            const s = JSON.parse(await evalPage(SAMPLE_JS));
            s.sec = sec;
            samples.push(s);
            appendFileSync(join(out, 'samples.jsonl'), JSON.stringify(s) + '\n');
        } catch (e) {
            samples.push({ sec, error: e.message });
        }
        for (const t of shotTimes) {
            if (t <= sec && !shotsTaken.has(t)) {
                shotsTaken.add(t);
                try {
                    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
                    writeFileSync(join(out, `shot-${String(t).padStart(3, '0')}s.png`), Buffer.from(data, 'base64'));
                } catch (e) {
                    log('cdp', 'screenshot failed ' + e.message);
                }
            }
        }
    }
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Extensions.uninstall', { id: extId }).catch(() => {});
    rmSync(extDir, { recursive: true, force: true });
    cdp.close();

    const text = readFileSync(logPath, 'utf8');
    const lines = text.split('\n');
    const has = (re) => lines.some((l) => re.test(l));
    const vids = samples.filter((s) => s.video);
    const first = vids.find((s) => s.video.t > 0);
    const last = vids[vids.length - 1];
    const summary = {
        evidence: out,
        url,
        injected: !opts['no-inject'],
        docStart: samples.find((s) => s.docStart)?.docStart || null,
        vaftLoading: lines.find((l) => /vaft v\d+ loading/.test(l))?.trim() || null,
        workerIntercepted: has(/\[page\].*Worker intercepted — injecting ad-block hooks/),
        workerStreamSession: lines.find((l) => /\[worker\].*New stream session/.test(l))?.trim() || null,
        gqlHeadersCaptured: has(/GQL headers captured/),
        milestones: lines.filter((l) => MILESTONES.test(l)).map((l) => l.trim()),
        bannerVisibleSecs: ranges(samples.filter((s) => s.banner && s.banner.visible).map((s) => s.sec)),
        bannerTexts: [...new Set(samples.filter((s) => s.banner && s.banner.visible).map((s) => s.banner.text))],
        video: last
            ? {
                  firstProgressAtSec: first ? first.sec : null,
                  finalTime: last.video.t,
                  advancedSec: first ? +(last.video.t - first.video.t).toFixed(2) : 0,
                  paused: last.video.paused,
                  readyState: last.video.readyState,
                  size: last.video.w + 'x' + last.video.h,
              }
            : null,
        stalledSecs: ranges(vids.filter((s, i) => i > 0 && s.video.t === vids[i - 1].video.t && !s.video.paused).map((s) => s.sec)),
        resolutions: [...new Set(vids.map((s) => s.video.w + 'x' + s.video.h))],
        playerErrorSecs: ranges(samples.filter((s) => s.playerError).map((s) => s.sec)),
        contentGate: samples.some((s) => s.gate),
        exceptions: lines.filter((l) => / EXCEPTION /.test(l)).slice(0, 20),
        errors: samples.filter((s) => s.error).map((s) => s.sec + ': ' + s.error).slice(0, 5),
    };
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------- main

const HELP = `vaftctl — drive vaft/vaft.user.js in real Chrome on live twitch.tv
  launch [--headful]        start an isolated Chrome (prints READY ...)
  doctor                    read-only health check (exit 0 = worth driving)
  channels [--n 10]         list live channels by viewer count
  drive [--channel C | --url U] [--seconds 30] [--name label]
        [--ls key=value]...  seed twitchAdSolutions_<key> before load (others are cleared)
        [--at "<sec>:<js>"]... evaluate page JS at <sec> (e.g. "8:simulateAds(1)")
        [--shots 5,15,29]    screenshot times   [--no-inject] baseline without vaft
        [--network]          log playlist/usher/GQL requests per session as [net] lines
  teardown                  kill the Chrome launch started, delete its profile; keep evidence
State/evidence dir: ${DIR} (override with VAFT_VERIFY_DIR)`;

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
if (cmd === 'launch') await launch(opts);
else if (cmd === 'teardown') await teardown();
else if (cmd === 'doctor') await doctor();
else if (cmd === 'channels') console.log((await liveChannels(Number(opts.n || 10))).map((c) => c.login + '\t' + c.viewers).join('\n'));
else if (cmd === 'drive') await drive(opts);
else console.log(HELP);
