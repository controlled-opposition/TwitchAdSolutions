/** Make a hook's toString() look like the native function it replaces. */
export function maskAsNative<T extends object>(fn: T, name: string): T {
    // Defined rather than assigned: an assignment goes through Function.prototype.toString, and
    // throws in strict mode if another script froze Function.prototype. Masking is cosmetic, so a
    // failure leaves the hook unmasked rather than stopping it.
    try {
        Object.defineProperty(fn, 'toString', {
            value: () => 'function ' + name + '() { [native code] }',
            writable: true,
            configurable: true,
        });
    } catch {}
    return fn;
}
