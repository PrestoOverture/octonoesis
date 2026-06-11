import type { Tool } from './Tool'

// A global registry map holding all active tools
const registry = new Map<string, Tool>()

/**
 * Registers a tool in the global registry map.
 * @param tool The Tool instance to register.
 */
export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
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
