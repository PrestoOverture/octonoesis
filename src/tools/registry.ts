import type { Tool } from './Tool'

// v1.0 invariant: one active query per process. Concurrent agents run in child processes and use
// child-side hardcoded tool tables; in-process concurrent query registries are deferred to v1.1+.
const registry = new Map<string, Tool>()

/**
 * Registers a tool in the global registry map.
 * @param tool The Tool instance to register.
 */
export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

/** Removes a tool, optionally only when the registered instance matches. */
export function unregisterTool(name: string, expected?: Tool): void {
  if (expected !== undefined && registry.get(name) !== expected) return
  registry.delete(name)
}

/**
 * Looks up a registered tool by its name.
 *
 * @param name The name of the tool.
 * @return The registered Tool instance, or undefined if not found.
 */
export function getTool(name: string): Tool | undefined {
  return registry.get(name)
}

/**
 * Retrieves all currently registered tools.
 *
 * @return An array containing all registered Tool instances.
 */
export function getAllTools(): Tool[] {
  return Array.from(registry.values())
}

/**
 * Resets and clears the global tool registry.
 */
export function clearRegistry(): void {
  registry.clear()
}
