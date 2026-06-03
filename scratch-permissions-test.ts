import { requestPermission } from './src/permissions/confirm'

async function main() {
  console.log('=== Starting Permission System Live Demonstration ===')

  // 1. First test: Allow once
  console.log("\n--- TEST 1: Requesting permission for 'bun test' (Should prompt) ---")
  const decision1 = await requestPermission('Bash', { command: 'bun test' })
  console.log(`Result: ${decision1}`)

  console.log(
    "\n--- TEST 2: Requesting permission for 'bun test' AGAIN (Should prompt again because it was only allowed once) ---",
  )
  const decision2 = await requestPermission('Bash', { command: 'bun test' })
  console.log(`Result: ${decision2}`)

  // 2. Second test: Allow always
  console.log("\n--- TEST 3: Requesting permission for 'sleep 5' (Should prompt) ---")
  console.log('👉 Please press [a] for this command to save it to the session allowlist.')
  const decision3 = await requestPermission('Bash', { command: 'sleep 5' })
  console.log(`Result: ${decision3}`)

  console.log(
    "\n--- TEST 4: Requesting permission for 'sleep 5' AGAIN (Should NOT prompt, should auto-approve) ---",
  )
  const decision4 = await requestPermission('Bash', { command: 'sleep 5' })
  console.log(`Result: ${decision4} (Success: Auto-approved!)`)
}

main().catch(console.error)
