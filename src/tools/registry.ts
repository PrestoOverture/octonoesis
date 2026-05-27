import type { Tool } from './Tool'

// A global registry map holding all active tools
const registry = new Map<string, Tool>()

/**
 * Register a tool in the global registry
 * @param tool
 */
export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

/**
 * Look up a tool by its name.
 * @param name
 * @returns
 */
export function getTool(name: string): Tool | undefined {
  return registry.get(name)
}

/**
 * Retrieve all registered tools.
 * @returns
 */
export function getAllTools(): Tool[] {
  return Array.from(registry.values())
}

/**
 * Reset/clear the registry (useful for clean testing).
 */
export function clearRegistry(): void {
  registry.clear()
}
