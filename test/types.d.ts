declare module 'bun:test' {
    export const test: (name: string, fn: () => void | Promise<void>) => void;
    export const it: (name: string, fn: () => void | Promise<void>) => void;
    export const describe: (name: string, fn: () => void | Promise<void>) => void;
    export const expect: (actual: any) => {
        toBe: (expected: any) => void;
        toEqual: (expected: any) => void;
        toBeDefined: () => void;
        toBeUndefined: () => void;
        toBeTruthy: () => void;
        toBeFalsy: () => void;
        toContain: (expected: any) => void;
        toThrow: (expected?: any) => void;
    };
}
