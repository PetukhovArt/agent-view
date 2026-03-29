import { AgentViewServer } from './server.js'

const server = new AgentViewServer()
server.start()
  .then(() => {
    process.stdout.write('READY\n')
  })
  .catch(err => {
    process.stderr.write(`Failed to start server: ${err}\n`)
    process.exit(1)
  })
