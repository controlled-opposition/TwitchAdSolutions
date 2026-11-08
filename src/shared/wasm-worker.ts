// Synchronous XHR: the Worker constructor that needs this script is synchronous.
const cache: Record<string, string> = Object.create(null);

export function getWasmWorkerJs(twitchBlobUrl: string): string {
    if (cache[twitchBlobUrl]) {
        return cache[twitchBlobUrl];
    }
    const req = new XMLHttpRequest();
    req.open('GET', twitchBlobUrl, false);
    req.overrideMimeType('text/javascript');
    req.send();
    const text = req.responseText;
    cache[twitchBlobUrl] = text;
    return text;
}
