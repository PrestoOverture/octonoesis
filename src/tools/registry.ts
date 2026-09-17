import type { Tool } from './Tool'

// One active query owns this process-global registry. Concurrent agents run in child processes
// and use child-side hardcoded tool tables; in-process concurrent queries are unsupported.
const registry = new Map<string, Tool>()

/**
 * Registers a tool in the global registry map.
 * @param tool The Tool instance to register.
 */
export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

/**
 * Removes a tool from the global registry, optionally only when the registered instance matches.
 *
 * @param name - The name of the tool to unregister.
 * @param expected - Optional Tool instance that must match the registered tool for removal to occur.
 */
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
