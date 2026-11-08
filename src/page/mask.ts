/** Make a hook's toString() look like the native function it replaces. */
export function maskAsNative<T extends object>(fn: T, name: string): T {
    // Defined, not assigned: assignment throws in strict mode when another script froze
    // Function.prototype, whose inherited toString is then non-writable.
    try {
        Object.defineProperty(fn, 'toString', {
            value: () => 'function ' + name + '() { [native code] }',
            writable: true,
            configurable: true,
        });
    } catch {}
    return fn;
}
