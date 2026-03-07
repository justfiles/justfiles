import { Hono } from 'hono'
import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
import { tursoStore } from './core/store/turso'
import { createApi } from './core/api'

const app = new Hono()

app.use('/api/*', clerkMiddleware())

const store = tursoStore('ghostore.db')
app.route('/api', createApi(store))
