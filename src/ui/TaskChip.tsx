import { Box, Text } from 'ink'
import React, { useEffect, useState } from 'react'
import type { QueryLoopContext } from '../query/types'

/**
 * Props for the TaskChip component rendering active background task indicators.
 */
export interface TaskChipProps {
  ctx: QueryLoopContext
  pollIntervalMs?: number
}

/**
 * Terminal UI component that renders live status chips for background tasks with elapsed times.
 *
 * @param props - Component properties containing the query context and optional polling interval
 * @returns Rendered box containing task status chips, or null if no tasks exist
 */
export function TaskChip({ ctx, pollIntervalMs = 1_000 }: TaskChipProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), pollIntervalMs)
    return () => clearInterval(interval)
  }, [pollIntervalMs])

  const tasks = Array.from(ctx.tasks?.values() ?? [])
  if (tasks.length === 0) return null

  return (
    <Box flexDirection="column">
      {tasks.map((task) => {
        const elapsedSeconds = Math.max(
          0,
          Math.floor(((task.endTime ?? Date.now()) - task.startTime) / 1_000),
        )
        return (
          <Text key={task.id} color={task.status === 'running' ? 'yellow' : 'gray'}>
            ⏺ {task.id} {task.type} {task.status} {elapsedSeconds}s
          </Text>
        )
      })}
    </Box>
  )
}
