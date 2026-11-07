// Installing hooks under strict mode. The script runs strict, where assigning to a property that
// another extension (or the browser) made read-only throws instead of failing silently. Every
// hook goes through installHook() so that case is logged and handled, never thrown.

/**
 * Set `target[key] = fn` and report whether the hook is really in place.
 *
 * Tries a plain assignment first. If that throws or doesn't stick and the property is an own,
 * configurable property of `target` (e.g. made read-only or getter-only by another extension),
 * redefines it. Never throws; logs and returns false when the property can't be replaced, so the
 * caller can fall back instead of running as if hooked.
 */
export function installHook<T extends object, K extends keyof T>(target: T, key: K, fn: T[K], label: string): boolean {
    try {
        target[key] = fn;
    } catch {}
    if (target[key] !== fn) {
        // Own properties only: a redefinition on an object with named-property semantics
        // (Storage) would not replace the inherited method.
        try {
            const desc = Object.getOwnPropertyDescriptor(target, key);
            if (desc?.configurable) {
                Object.defineProperty(target, key, {
                    value: fn,
                    writable: true,
                    configurable: true,
                    enumerable: desc.enumerable,
                });
            }
        } catch {}
    }
    let hooked = false;
    try {
        hooked = target[key] === fn;
    } catch {}
    if (!hooked) {
        console.log(
            '[AD DEBUG] Could not hook ' + label + ': the browser or another extension does not let it be replaced',
        );
    }
    return hooked;
}
