import { Text } from 'ink'
import React, { useEffect, useState } from 'react'
const VERBS = [
  'Contemplating',
  'Tracing',
  'Weighing evidence',
  'Consulting the ledger',
  'Connecting nodes',
]
export function Spinner({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 120)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, now - startedAt)
  return (
    <Text wrap="truncate-end">{`${['✶', '✸', '✹', '✺'][Math.floor(elapsed / 120) % 4]} ${VERBS[Math.floor(elapsed / 8000) % VERBS.length]}… ${Math.floor(elapsed / 1000)}s · ctrl+c to interrupt`}</Text>
  )
}
