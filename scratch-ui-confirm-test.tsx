import { render } from 'ink'
import React from 'react'
import { ConfirmDialog } from './src/ui/ConfirmDialog'

function main() {
  console.log('=== Launching Live TUI Confirm Dialog ===\n')

  const { unmount } = render(
    <ConfirmDialog
      toolName="Bash"
      input={{ command: 'bun run build:bin', duration: '120s', clean: true }}
      onResolve={(decision) => {
        unmount()
        console.log(`\n\nResult Captured: You selected "${decision}"!\n`)
        process.exit(0)
      }}
    />,
  )
}

main()
