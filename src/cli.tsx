import { Command } from 'commander'
import { callAnthropicStream } from './providers/anthropic'

const program = new Command()

program
  .name('octonoesis')
  .description('An open-source terminal coding agent')
  .version('0.0.1')
  .argument('[prompt]', 'One-shot prompt to send to the model')
  .action(async (prompt?: string) => {
    if (!prompt) {
      console.log('Hello from Octonoesis.')
      return
    }

    try {
      for await (const delta of callAnthropicStream(prompt)) {
        process.stdout.write(delta.text)
      }
      process.stdout.write('\n')
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
      }
      throw error
    }
  })

program.parse(process.argv)
