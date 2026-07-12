import type { HookEvent, HookMatcher } from './types'

function matchesToolPattern(pattern: string | undefined, tool: string | undefined): boolean {
  if (pattern === undefined) return true
  if (tool === undefined) return false
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1))
  return tool === pattern
}

export class HookRegistry {
  private readonly matchers: HookMatcher[] = []

  register(matcher: HookMatcher): void {
    this.matchers.push(matcher)
  }

  match(event: HookEvent, tool?: string): HookMatcher[] {
    return this.matchers.filter(
      (matcher) => matcher.event === event && matchesToolPattern(matcher.toolPattern, tool),
    )
  }
}

const registries = new WeakMap<object, HookRegistry>()

export function attachHookRegistry(context: object, registry: HookRegistry): void {
  registries.set(context, registry)
}

export function getAttachedHookRegistry(context: object): HookRegistry | undefined {
  return registries.get(context)
}
