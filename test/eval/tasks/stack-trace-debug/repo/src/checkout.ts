import { receipt } from './receipt'
export function checkout(row: { unit_cents: number; quantity: number }): string {
  return receipt({ unitCents: row.unit_cents, count: (row as unknown as { count: number }).count })
}
