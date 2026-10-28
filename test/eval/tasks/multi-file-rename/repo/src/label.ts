import { type User, formatUser } from './user'

export function userLabel(user: User): string {
  return `User ${formatUser(user)}`
}
