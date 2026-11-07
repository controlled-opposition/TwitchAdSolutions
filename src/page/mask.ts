/** Make a hook's toString() look like the native function it replaces. */
export function maskAsNative<T extends object>(fn: T, name: string): T {
    fn.toString = () => 'function ' + name + '() { [native code] }';
    return fn;
}
