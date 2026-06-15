export interface User {
  name?: string
}

export function handleUser(user?: User | null): string {
  // @ts-ignore - Intentionally buggy for testing, ignoring compiler error
  return `Hello, ${user.name.toUpperCase()}!`
}
