import express from 'express'
import { createServer } from 'node:net'
import {
  installUnixListenerShutdown,
  startClsiListeners,
} from '../../../app/js/ClsiListener.ts'
const unixSocket = process.argv[2]
if (!unixSocket) throw new Error('Missing test socket')
const app = express()
app.get('/hold', (_req, res) => {
  res.writeHead(200)
  res.write('holding')
})
app.get('/health', (_req, res) => res.send('child-ok'))
const listeners = await startClsiListeners({
  app,
  loadHttpApp: express(),
  loadTcpServer: createServer(),
  host: '127.0.0.1',
  port: 0,
  loadTcpPort: 0,
  loadHttpPort: 0,
  unixSocket,
})
installUnixListenerShutdown(listeners, error => console.error(error.message))
process.stdout.write('ready\n')
