export function installHook<T extends object, K extends keyof T>(target: T, key: K, fn: T[K], label: string): boolean {
    try {
        target[key] = fn;
    } catch {}
    if (target[key] !== fn) {
        // Own properties only: defineProperty on a Storage object runs its named property setter
        // (stores an item) instead of replacing the inherited method (WebIDL legacy platform
        // object [[DefineOwnProperty]]).
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
