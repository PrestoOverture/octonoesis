declare module 'bun:test' {
  export const test: (name: string, fn: () => void | Promise<void>) => void
  export const it: (name: string, fn: () => void | Promise<void>) => void
  export const describe: (name: string, fn: () => void | Promise<void>) => void
  export const expect: (actual: any) => ExpectedMethods & { not: ExpectedMethods }
  export const beforeAll: (fn: () => void | Promise<void>) => void
  export const afterAll: (fn: () => void | Promise<void>) => void
  export const beforeEach: (fn: () => void | Promise<void>) => void
  export const afterEach: (fn: () => void | Promise<void>) => void
  export const mock: {
    (fn: (...args: any[]) => any): any
    module: (moduleName: string, factory: () => any) => void
  }
  interface ExpectedMethods {
    toBe: (expected: any) => void
    toEqual: (expected: any) => void
    toBeDefined: () => void
    toBeUndefined: () => void
    toBeTruthy: () => void
    toBeFalsy: () => void
    toContain: (expected: any) => void
    toThrow: (expected?: any) => void
    rejects: ExpectedMethods & { not: ExpectedMethods }
    resolves: ExpectedMethods & { not: ExpectedMethods }
  }
}

interface ImportMeta {
  dir: string
  path: string
}
