import type { M3u8Attributes, ResolutionInfo, VideoCodecFamily } from '../shared/types.ts';
import { state } from './state.ts';

export function parseAttributes(str: string): M3u8Attributes {
    if (!str) return {};
    // Normalize: always pass only attribute section
    if (str.charCodeAt(0) === 35) {
        // '#'
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
// Find the closest matching stream URL for a given resolution from a master m3u8
// Video codec family from an m3u8 CODECS attribute. Returns 'unknown' for a missing or
// unrecognised attribute rather than throwing — a variant without CODECS used to blow up
// the raw .startsWith() checks below and hang the master-playlist fetch. Ported from
// testing v674.
export function videoCodecFamily(codecs: string | undefined): VideoCodecFamily {
    if (!codecs) return 'unknown';
    // Scan every comma-separated entry rather than assuming the video codec is listed
    // first — an audio-first CODECS value would otherwise silently classify 'unknown'.
    const parts = String(codecs).toLowerCase().split(',');
    for (let i = 0; i < parts.length; i++) {
        const c = parts[i].trim();
        if (c.startsWith('avc')) return 'avc';
        if (c.startsWith('hev') || c.startsWith('hvc')) return 'hevc';
        if (c.startsWith('av0')) return 'av1';
    }
    return 'unknown';
}
// HEVC and AV1: codecs that can go black for a whole ad break when the backup stream switches
// to AVC, so a stream carrying them is swapped onto its AVC variants.
export function isEnhancedCodec(codecs: string | undefined): boolean {
    const family = videoCodecFamily(codecs);
    return family === 'hevc' || family === 'av1';
}
// Pixel area of an m3u8 RESOLUTION value ('1920x1080'), for picking the closest variant.
export function resolutionArea(resolution: string): number {
    const [width, height] = resolution.split('x').map(Number);
    return width * height;
}
/** A variant playlist from a master (encodings) playlist. */
interface StreamVariant {
    url: string;
    codecs: string;
}

/**
 * The variant of `encodingsM3u8` closest to `resolutionInfo`: same resolution (and frame rate
 * when possible), else the closest pixel area. When `resolutionInfo.Codecs` is given, variants of
 * the same video codec family are preferred (any resolution) over other families: a backup in
 * another codec can't be fed into the player's MediaSource.
 */
export function getStreamVariantForResolution(
    encodingsM3u8: string,
    resolutionInfo: Pick<ResolutionInfo, 'Resolution' | 'FrameRate'> & { Codecs?: string },
): StreamVariant | null {
    const encodingsLines = encodingsM3u8.split(/\r?\n/);
    const variants: { url: string; resolution: string; frameRate: unknown; codecs: string }[] = [];
    for (let i = 0; i < encodingsLines.length - 1; i++) {
        // Accept v2 API variant URLs which are raw CDN URLs without '.m3u8' in the path.
        // v1 API: next line is '...index-<resolution>.m3u8?...'
        // v2 API: next line is a raw CDN URL like 'https://video-edge-...net/v1/.../chunked/...'
        // without '.m3u8'. Matching only on '.m3u8' would skip v2 variants entirely,
        // causing backup selection to fail.
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

/**
 * Whether a backup variant in `backupCodecs` can't be fed to a player decoding `playerCodecs`.
 * A player on an enhanced codec (HEVC/AV1) needs that same family (an unknown one counts as a
 * mismatch, as the AVC swap is the norm); an AVC/unknown player only mismatches an enhanced backup.
 */
export function isCodecMismatch(playerCodecs: string, backupCodecs: string): boolean {
    if (isEnhancedCodec(playerCodecs)) {
        return videoCodecFamily(backupCodecs) !== videoCodecFamily(playerCodecs);
    }
    return isEnhancedCodec(backupCodecs);
}

/** A variant of a master playlist: its URL line, and its ResolutionInfo when it has a RESOLUTION. */
interface MasterVariant {
    url: string;
    resolution: ResolutionInfo | null;
}

/**
 * The variants of the main stream's master playlist. Unlike getStreamVariantForResolution, only
 * URL lines containing '.m3u8' count, untrimmed.
 */
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
                      // CODECS is optional on a STREAM-INF line; keep every field string-valued so
                      // readers can call string methods without a guard.
                      Codecs: attributes['CODECS'] || '',
                      // Copied onto the rewritten line by buildAvcOnlyMaster, so it references
                      // media groups the AVC variant carries (TTV-AB v6.7.5 parser fix).
                      Audio: attributes['AUDIO'] || '',
                      Video: attributes['VIDEO'] || '',
                      Subtitles: attributes['SUBTITLES'] || '',
                      Url: lines[i + 1],
                  }
                : null,
        };
    }
}

// Replace a STREAM-INF attribute if present, else append it after a comma. An empty or
// non-string value leaves the line unchanged.
function replaceOrAppendStreamInfAttr(line: string, key: string, value: unknown): string {
    if (typeof value !== 'string' || !value) return line;
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const next = key + '="' + escaped + '"';
    const pattern = new RegExp('(^|,)' + key + '=("[^"]*"|[^,]*)');
    return pattern.test(line) ? line.replace(pattern, '$1' + next) : line + ',' + next;
}

/**
 * The master playlist served during a codec swap: every enhanced (HEVC/AV1) variant line points
 * at the AVC variant of closest pixel area instead. Null when the stream has no enhanced variant
 * or no AVC one. AV1 counts as enhanced: like HEVC it can go black for a whole ad break on some
 * browsers/hardware (GosuDRM/TTV-AB #47), so only AVC is a swap target (TTV-AB v12.0.9).
 */
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
        if (!target) continue; // every area NaN (malformed RESOLUTION)
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
