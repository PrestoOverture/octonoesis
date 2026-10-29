export function greet(user?: { name?: string } | null): string {
  return `Hello, ${user!.name!.toUpperCase()}!`
}
