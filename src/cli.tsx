import { Command } from 'commander'

const program = new Command()

program
  .name('octonoesis')
  .description('An open-source terminal coding agent')
  .version('0.0.1')
  .action(() => {
    console.log('hello agent')
  })

program.parse(process.argv)
