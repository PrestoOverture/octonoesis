export async function loadNames(
  ids: number[],
  lookup: (id: number) => Promise<string>,
): Promise<string[]> {
  const names: string[] = []
  ids.forEach(async (id) => {
    names.push(await lookup(id))
  })
  return names
}
