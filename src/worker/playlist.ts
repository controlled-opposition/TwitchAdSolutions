import type { M3u8Attributes, ResolutionInfo, VideoCodecFamily } from '../shared/types.ts';
import { state } from './state.ts';

export function parseAttributes(str: string): M3u8Attributes {
    if (!str) return {};
    if (str.charCodeAt(0) === 35) {
        const idx = str.indexOf(':');
        if (idx !== -1) str = str.slice(idx + 1);
    }
    return Object.fromEntries(
        str
            .split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map((x) => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? (value.startsWith('"') ? JSON.parse(value) : value) : num];
            }),
    );
}
export function getServerTimeFromM3u8(encodingsM3u8: string): string | null {
    if (state.V2API) {
        const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
    return matches && matches.length > 1 ? matches[1] : null;
}
export function replaceServerTimeInM3u8(encodingsM3u8: string, newServerTime: string | null): string {
    if (state.V2API) {
        return newServerTime
            ? encodingsM3u8.replace(
                  /(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/,
                  `$1${newServerTime}$2`,
              )
            : encodingsM3u8;
    }
    return newServerTime
        ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`)
        : encodingsM3u8;
}
export function videoCodecFamily(codecs: string | undefined): VideoCodecFamily {
    if (!codecs) return 'unknown';
    // RFC 8216 doesn't order CODECS entries, so the video codec may not be first.
    const parts = String(codecs).toLowerCase().split(',');
    for (let i = 0; i < parts.length; i++) {
        const c = parts[i].trim();
        if (c.startsWith('avc')) return 'avc';
        if (c.startsWith('hev') || c.startsWith('hvc')) return 'hevc';
        if (c.startsWith('av0')) return 'av1';
    }
    return 'unknown';
}
// HEVC and AV1 can go black for a whole ad break when the backup stream switches to AVC on some
// browsers/hardware (GosuDRM/TTV-AB #47), so a stream carrying them is swapped onto its AVC variants.
export function isEnhancedCodec(codecs: string | undefined): boolean {
    const family = videoCodecFamily(codecs);
    return family === 'hevc' || family === 'av1';
}
export function resolutionArea(resolution: string): number {
    const [width, height] = resolution.split('x').map(Number);
    return width * height;
}
interface StreamVariant {
    url: string;
    codecs: string;
}

// A backup in another codec family can't be fed into the player's MediaSource.
export function getStreamVariantForResolution(
    encodingsM3u8: string,
    resolutionInfo: Pick<ResolutionInfo, 'Resolution' | 'FrameRate'> & { Codecs?: string },
): StreamVariant | null {
    const encodingsLines = encodingsM3u8.split(/\r?\n/);
    const variants: { url: string; resolution: string; frameRate: unknown; codecs: string }[] = [];
    for (let i = 0; i < encodingsLines.length - 1; i++) {
        // v2 API variant lines are raw CDN URLs without '.m3u8'.
        const nextLine = encodingsLines[i + 1]?.trim();
        if (
            encodingsLines[i].startsWith('#EXT-X-STREAM-INF') &&
            nextLine &&
            !nextLine.startsWith('#') &&
            (nextLine.includes('.m3u8') || nextLine.includes('://'))
        ) {
            const attributes = parseAttributes(encodingsLines[i]);
            if (attributes['RESOLUTION']) {
                variants.push({
                    url: encodingsLines[i + 1],
                    resolution: attributes['RESOLUTION'],
                    frameRate: attributes['FRAME-RATE'],
                    codecs: attributes['CODECS'] || '',
                });
            }
        }
    }
    const family = videoCodecFamily(resolutionInfo.Codecs);
    const sameFamily = family === 'unknown' ? [] : variants.filter((v) => videoCodecFamily(v.codecs) === family);
    const candidates = sameFamily.length > 0 ? sameFamily : variants;
    const targetArea = resolutionArea(resolutionInfo.Resolution);
    let closest = null;
    let closestDifference = Infinity;
    for (const v of candidates) {
        if (v.resolution === resolutionInfo.Resolution && v.frameRate === resolutionInfo.FrameRate) {
            return { url: v.url, codecs: v.codecs };
        }
        const difference = Math.abs(resolutionArea(v.resolution) - targetArea);
        if (difference < closestDifference) {
            closest = v;
            closestDifference = difference;
        }
    }
    return closest ? { url: closest.url, codecs: closest.codecs } : null;
}

export function isCodecMismatch(playerCodecs: string, backupCodecs: string): boolean {
    if (isEnhancedCodec(playerCodecs)) {
        return videoCodecFamily(backupCodecs) !== videoCodecFamily(playerCodecs);
    }
    return isEnhancedCodec(backupCodecs);
}

interface MasterVariant {
    url: string;
    resolution: ResolutionInfo | null;
}

export function* parseMasterVariants(encodingsM3u8: string): Generator<MasterVariant> {
    const lines = encodingsM3u8.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF') || !lines[i + 1].includes('.m3u8')) {
            continue;
        }
        const attributes = parseAttributes(lines[i]);
        const resolution = attributes['RESOLUTION'];
        yield {
            url: lines[i + 1],
            resolution: resolution
                ? {
                      Resolution: resolution,
                      FrameRate: attributes['FRAME-RATE'],
                      Codecs: attributes['CODECS'] || '',
                      // Copied onto the rewritten line by buildAvcOnlyMaster, so it references media
                      // groups the AVC variant carries.
                      Audio: attributes['AUDIO'] || '',
                      Video: attributes['VIDEO'] || '',
                      Subtitles: attributes['SUBTITLES'] || '',
                      Url: lines[i + 1],
                  }
                : null,
        };
    }
}

function replaceOrAppendStreamInfAttr(line: string, key: string, value: unknown): string {
    if (typeof value !== 'string' || !value) return line;
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const next = key + '="' + escaped + '"';
    const pattern = new RegExp('(^|,)' + key + '=("[^"]*"|[^,]*)');
    return pattern.test(line) ? line.replace(pattern, '$1' + next) : line + ',' + next;
}

export function buildAvcOnlyMaster(encodingsM3u8: string, variants: ResolutionInfo[]): string | null {
    const avcVariants = variants.filter((v) => videoCodecFamily(v.Codecs) === 'avc');
    if (avcVariants.length === 0 || !variants.some((v) => isEnhancedCodec(v.Codecs))) {
        return null;
    }
    const lines = encodingsM3u8.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) {
            continue;
        }
        const attributes = parseAttributes(lines[i]);
        if (!isEnhancedCodec(attributes['CODECS'])) {
            continue;
        }
        const oldResolution = attributes['RESOLUTION'];
        const targetArea = resolutionArea(oldResolution);
        let target = null;
        let closestDiff = Infinity;
        for (const candidate of avcVariants) {
            const diff = Math.abs(resolutionArea(candidate.Resolution) - targetArea);
            if (diff < closestDiff) {
                closestDiff = diff;
                target = candidate;
            }
        }
        if (!target) continue;
        console.log(
            'ModifiedM3U8 swap ' +
                attributes['CODECS'] +
                ' to ' +
                target.Codecs +
                ' oldRes:' +
                oldResolution +
                ' newRes:' +
                target.Resolution,
        );
        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${target.Codecs}"`);
        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'AUDIO', target.Audio);
        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'VIDEO', target.Video);
        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'SUBTITLES', target.Subtitles);
        lines[i + 1] = target.Url + ' '.repeat(i + 1); // The stream doesn't load unless each url line is unique
    }
    return lines.join('\n');
}
