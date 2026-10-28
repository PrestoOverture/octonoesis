import { price } from './price'
export function receipt(row: { unitCents: number; count: number }): string { return price(row.unitCents * row.count) }
