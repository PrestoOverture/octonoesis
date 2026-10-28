export interface User {
  id: string
  name: string
}

export function formatUser(user: User): string {
  return `${user.id}: ${user.name}`
}
