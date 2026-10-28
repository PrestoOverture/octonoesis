import { normalize } from './normalize'
export function search(values: string[], query: string): string[] {
  return values.filter(value => normalize(value).includes(query))
}
