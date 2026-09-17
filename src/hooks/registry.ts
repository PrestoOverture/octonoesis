import type { HookEvent, HookMatcher } from './types'

/**
 * Checks whether a tool name matches a hook's tool pattern wildcard expression.
 * Supports exact matches, prefix wildcards (e.g. `'mcp__*'`), and universal wildcards (`'*'`).
 *
 * @param pattern - Wildcard pattern or undefined (matches all tools).
 * @param tool - Tool name to check or undefined.
 * @returns True if the tool satisfies the pattern match.
 */
function matchesToolPattern(pattern: string | undefined, tool: string | undefined): boolean {
  if (pattern === undefined) return true
  if (tool === undefined) return false
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1))
  return tool === pattern
}

export class HookRegistry {
  private readonly matchers: HookMatcher[] = []

  /**
   * Registers a new hook matcher with event, optional tool pattern, timeout, and handler.
   *
   * @param matcher - Hook matcher configuration object.
   */
  register(matcher: HookMatcher): void {
    this.matchers.push(matcher)
  }

  /**
   * Finds all registered hook matchers that match the specified lifecycle event and optional tool name.
   *
   * @param event - Lifecycle event name (e.g. `'pre_tool_use'`, `'stop'`).
   * @param tool - Optional tool name being executed.
   * @returns Array of matching hook matcher configurations.
   */
  match(event: HookEvent, tool?: string): HookMatcher[] {
    return this.matchers.filter(
      (matcher) => matcher.event === event && matchesToolPattern(matcher.toolPattern, tool),
    )
  }
}
