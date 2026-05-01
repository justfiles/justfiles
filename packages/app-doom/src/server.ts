import { serveApp } from '@justfiles/app/server'
import app from './app'
import index from './index.html'

const server = serveApp({ app, html: index })
console.log(`Dev harness running at ${server.url}`)
