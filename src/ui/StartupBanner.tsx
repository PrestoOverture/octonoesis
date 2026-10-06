import { Box, Text, useInput } from 'ink'
import React, { useEffect, useRef, useState } from 'react'

export interface BannerSnapshot {
  lines: string[]
  mascot?: string
  layout: 'beside' | 'above' | 'text'
}
export function Banner({ lines, mascot, layout }: BannerSnapshot) {
  return (
    <Box flexDirection={layout === 'beside' ? 'row' : 'column'} flexShrink={0}>
      {mascot ? (
        <Box width={33} flexShrink={0} marginRight={layout === 'beside' ? 2 : 0}>
          <Text>{mascot}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        {lines.map((line) => (
          <Text key={line} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
export function StartupBanner({
  snapshot,
  frames,
  animate,
}: { snapshot: BannerSnapshot; frames: string[]; animate: boolean }) {
  const [frame, setFrame] = useState(0)
  const [idle, setIdle] = useState(false)
  const lastKey = useRef(Date.now())
  useInput(() => {
    lastKey.current = Date.now()
    setIdle(false)
  })
  useEffect(() => {
    if (!animate || idle) return
    const timer = setInterval(() => {
      if (Date.now() - lastKey.current >= 300000) {
        setIdle(true)
        return
      }
      setFrame((value) => (value + 1) % 4)
    }, 450)
    return () => clearInterval(timer)
  }, [animate, idle])
  return (
    <Banner
      {...snapshot}
      mascot={snapshot.mascot ? frames[animate && !idle ? frame : 1] : undefined}
    />
  )
}
