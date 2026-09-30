import { join, dirname, resolve } from 'node:path'
import { mkdir, readdir, rename } from 'node:fs/promises'

type SSEClient = WritableStreamDefaultWriter<Uint8Array>

const APP_DIR = dirname(new URL(import.meta.url).pathname)
const DIST_DIR = join(APP_DIR, 'dist')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

interface ServerOptions {
  port?: number
  viewsDir?: string
}

const startTime = Date.now()

export function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? (Number(process.env.PORT) || 7201)
  const viewsDir = resolve(opts.viewsDir ?? process.env.VIEWS_DIR ?? 'thoughts/shared/views')
  const clients = new Set<SSEClient>()

  // Ensure the views dir exists at launch so users see a valid path immediately
  mkdir(viewsDir, { recursive: true }).catch(() => {})

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  function sanitizeFilename(name: string): string {
    return name.replace(/[\/\\:*?"<>|]/g, '_')
  }

  async function pushSSE(data: Record<string, unknown>) {
    const payload = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
    const dead: SSEClient[] = []
    for (const client of clients) {
      try {
        await client.write(payload)
      } catch {
        dead.push(client)
      }
    }
    for (const c of dead) clients.delete(c)
  }

  const server = Bun.serve({
    port,
    idleTimeout: 255, // max seconds for SSE connections
    fetch: async (req) => {
      const url = new URL(req.url)

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders })
      }

      if (url.pathname === '/health') {
        return Response.json(
          { viewsDir, uptime: Math.floor((Date.now() - startTime) / 1000) },
          { headers: corsHeaders }
        )
      }

      if (req.method === 'POST' && url.pathname === '/api/save') {
        let body: { name?: string; document?: unknown }
        try {
          body = await req.json()
        } catch {
          return new Response('Invalid JSON', { status: 400, headers: corsHeaders })
        }

        if (!body.name || !body.document) {
          return new Response('Missing name or document', { status: 400, headers: corsHeaders })
        }

        const savedAt = new Date().toISOString()
        const filename = sanitizeFilename(body.name) + '.json'
        const filepath = join(viewsDir, filename)

        await mkdir(viewsDir, { recursive: true })
        await Bun.write(
          filepath,
          JSON.stringify({ name: body.name, savedAt, document: body.document }, null, 2)
        )

        await pushSSE({ name: body.name, savedAt })

        return Response.json({ ok: true, savedAt }, { headers: corsHeaders })
      }

      if (req.method === 'POST' && url.pathname === '/api/screenshot') {
        const name = req.headers.get('X-View-Name')
        if (!name) {
          return new Response('Missing X-View-Name header', { status: 400, headers: corsHeaders })
        }
        const blob = await req.blob()
        if (blob.size === 0) {
          return new Response('Empty body', { status: 400, headers: corsHeaders })
        }
        const filename = sanitizeFilename(name) + '.png'
        const filepath = join(viewsDir, filename)
        await mkdir(viewsDir, { recursive: true })
        await Bun.write(filepath, blob)
        return Response.json({ ok: true, filename }, { headers: corsHeaders })
      }

      if (req.method === 'GET' && url.pathname === '/api/load') {
        const name = url.searchParams.get('name')
        if (!name) {
          return new Response('Missing name param', { status: 400, headers: corsHeaders })
        }

        const filename = sanitizeFilename(name) + '.json'
        const file = Bun.file(join(viewsDir, filename))

        if (!(await file.exists())) {
          return new Response('Not found', { status: 404, headers: corsHeaders })
        }

        return new Response(await file.text(), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      if (req.method === 'GET' && url.pathname === '/api/list') {
        await mkdir(viewsDir, { recursive: true })
        const files = await readdir(viewsDir)
        const views = files
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''))
          .sort()
        return Response.json(views, { headers: corsHeaders })
      }

      if (req.method === 'POST' && url.pathname === '/api/rename') {
        let body: { from?: string; to?: string }
        try {
          body = await req.json()
        } catch {
          return new Response('Invalid JSON', { status: 400, headers: corsHeaders })
        }
        if (!body.from || !body.to) {
          return new Response('Missing from or to', { status: 400, headers: corsHeaders })
        }

        const fromFile = join(viewsDir, sanitizeFilename(body.from) + '.json')
        const toFile = join(viewsDir, sanitizeFilename(body.to) + '.json')

        if (!(await Bun.file(fromFile).exists())) {
          return new Response('Source not found', { status: 404, headers: corsHeaders })
        }

        // Read, update the name field inside, write to new path
        const data = await Bun.file(fromFile).json()
        data.name = body.to
        data.savedAt = new Date().toISOString()
        await Bun.write(toFile, JSON.stringify(data, null, 2))

        // Remove old file if name actually changed
        if (fromFile !== toFile) {
          await Bun.file(fromFile).exists() && await rename(fromFile, fromFile + '.bak')
        }

        await pushSSE({ name: body.to, renamed: true, from: body.from })

        return Response.json({ ok: true, name: body.to }, { headers: corsHeaders })
      }

      if (url.pathname === '/events') {
        const stream = new TransformStream<Uint8Array, Uint8Array>()
        const writer = stream.writable.getWriter()
        clients.add(writer)

        // Send initial comment to flush headers
        writer.write(new TextEncoder().encode(': connected\n\n')).catch(() => {})

        // Clean up on disconnect
        req.signal.addEventListener('abort', () => {
          clients.delete(writer)
          writer.close().catch(() => {})
        })

        return new Response(stream.readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...corsHeaders,
          },
        })
      }

      // Serve built frontend from dist/
      const filePath = join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname)
      const file = Bun.file(filePath)
      if (await file.exists()) {
        const ext = filePath.substring(filePath.lastIndexOf('.'))
        return new Response(file, {
          headers: { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream', ...corsHeaders },
        })
      }

      // SPA fallback — serve index.html for unmatched routes
      const indexFile = Bun.file(join(DIST_DIR, 'index.html'))
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { 'Content-Type': 'text/html', ...corsHeaders },
        })
      }

      return new Response('Not found — run "bun run build" to generate the frontend', { status: 404, headers: corsHeaders })
    },
  })

  return {
    port: server.port,
    viewsDir,
    stop: () => {
      for (const client of clients) {
        client.close().catch(() => {})
      }
      clients.clear()
      server.stop()
    },
  }
}

// Run as standalone if executed directly
if (import.meta.main) {
  const s = startServer()
  console.log(`qara-view API server running on :${s.port}`)
  console.log(`Frontend: http://localhost:${s.port}/`)
  console.log(`Views dir: ${s.viewsDir}`)
}
