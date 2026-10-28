export function isTicket(value: string): boolean {
  return /BUG-\d*/.test(value)
}
