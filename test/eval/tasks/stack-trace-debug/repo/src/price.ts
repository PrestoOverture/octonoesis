export function price(cents: number): string {
  if (!Number.isFinite(cents)) throw new Error('invalid cents')
  return (cents / 100).toFixed(2)
}
