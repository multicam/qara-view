import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import wireframe from './fixtures/wireframe.json'
import flow from './fixtures/flow.json'
import empty from './fixtures/empty.json'

const PORT = 7291 // test port, not 7201

let server: { stop: () => void }
let viewsDir: string
const base = `http://localhost:${PORT}`

beforeAll(async () => {
  viewsDir = await mkdtemp(join(tmpdir(), 'qara-view-test-'))
  const mod = await import('../server.ts')
  server = mod.startServer({ port: PORT, viewsDir })
})

afterAll(async () => {
  server?.stop()
  await rm(viewsDir, { recursive: true, force: true })
})

describe('POST /api/save', () => {
  it('writes JSON to VIEWS_DIR and returns 200', async () => {
    const res = await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-wireframe', document: wireframe }),
    })
    expect(res.status).toBe(200)

    const file = Bun.file(join(viewsDir, 'test-wireframe.json'))
    expect(await file.exists()).toBe(true)
  })

  it('written JSON contains name, savedAt, document (no session)', async () => {
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'check-fields', document: wireframe }),
    })

    const data = await Bun.file(join(viewsDir, 'check-fields.json')).json()
    expect(data.name).toBe('check-fields')
    expect(typeof data.savedAt).toBe('string')
    expect(data.document).toBeDefined()
    expect(data.session).toBeUndefined()
  })

  it('file on disk is valid parseable JSON', async () => {
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'valid-json', document: flow }),
    })

    const text = await Bun.file(join(viewsDir, 'valid-json.json')).text()
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('returns 400 with missing body', async () => {
    const res = await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/load', () => {
  beforeEach(async () => {
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'loadable', document: wireframe }),
    })
  })

  it('returns saved JSON for existing name', async () => {
    const res = await fetch(`${base}/api/load?name=loadable`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.name).toBe('loadable')
    expect(data.document).toBeDefined()
  })

  it('returns 404 for missing name', async () => {
    const res = await fetch(`${base}/api/load?name=nonexistent`)
    expect(res.status).toBe(404)
  })
})

describe('GET /health', () => {
  it('returns 200 with viewsDir and uptime', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.viewsDir).toBe(viewsDir)
    expect(typeof data.uptime).toBe('number')
  })
})

describe('GET /events (SSE)', () => {
  it('returns text/event-stream content type', async () => {
    const controller = new AbortController()
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    controller.abort()
  })

  it('receives event on save', async () => {
    const events: string[] = []
    const controller = new AbortController()

    // Connect SSE
    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Read events in background
    const reading = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          events.push(decoder.decode(value))
        }
      } catch {
        // abort will cause an error
      }
    })()

    // Give SSE connection time to establish
    await Bun.sleep(50)

    // Trigger a save
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sse-test', document: empty }),
    })

    await Bun.sleep(50)
    controller.abort()
    await reading

    const combined = events.join('')
    expect(combined).toContain('data:')
    expect(combined).toContain('sse-test')
  })

  it('notifies multiple connected clients', async () => {
    const controllers = [new AbortController(), new AbortController()]
    const allEvents: string[][] = [[], []]

    // Connect two SSE clients
    const readers = await Promise.all(
      controllers.map(async (ctrl, i) => {
        const res = await fetch(`${base}/events`, { signal: ctrl.signal })
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        ;(async () => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              allEvents[i]!.push(decoder.decode(value))
            }
          } catch {
            // abort
          }
        })()
        return reader
      })
    )

    await Bun.sleep(50)

    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'multi-client', document: empty }),
    })

    await Bun.sleep(50)
    controllers.forEach((c) => c.abort())

    expect(allEvents[0]!.join('')).toContain('multi-client')
    expect(allEvents[1]!.join('')).toContain('multi-client')
  })

  it('delivers all events from rapid successive saves', async () => {
    const events: string[] = []
    const controller = new AbortController()

    const res = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const reading = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          events.push(decoder.decode(value))
        }
      } catch {
        // abort
      }
    })()

    await Bun.sleep(50)

    // Rapid-fire 3 saves
    await Promise.all([
      fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rapid-1', document: empty }),
      }),
      fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rapid-2', document: empty }),
      }),
      fetch(`${base}/api/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rapid-3', document: empty }),
      }),
    ])

    await Bun.sleep(100)
    controller.abort()
    await reading

    const combined = events.join('')
    expect(combined).toContain('rapid-1')
    expect(combined).toContain('rapid-2')
    expect(combined).toContain('rapid-3')
  })
})

describe('GET /api/list', () => {
  it('returns saved view names', async () => {
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'list-a', document: empty }),
    })
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'list-b', document: empty }),
    })

    const res = await fetch(`${base}/api/list`)
    expect(res.status).toBe(200)
    const views: string[] = await res.json()
    expect(views).toContain('list-a')
    expect(views).toContain('list-b')
  })
})

describe('POST /api/rename', () => {
  it('renames a view file and updates the name field inside', async () => {
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'old-name', document: wireframe }),
    })

    const res = await fetch(`${base}/api/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'old-name', to: 'new-name' }),
    })
    expect(res.status).toBe(200)

    // New file exists with updated name field
    const loaded = await (await fetch(`${base}/api/load?name=new-name`)).json()
    expect(loaded.name).toBe('new-name')
    expect(loaded.document).toBeDefined()
  })

  it('returns 404 for nonexistent source', async () => {
    const res = await fetch(`${base}/api/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ghost', to: 'whatever' }),
    })
    expect(res.status).toBe(404)
  })

  it('pushes SSE event on rename', async () => {
    await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'rename-sse', document: empty }),
    })

    const events: string[] = []
    const controller = new AbortController()
    const sseRes = await fetch(`${base}/events`, { signal: controller.signal })
    const reader = sseRes.body!.getReader()
    const decoder = new TextDecoder()
    const reading = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          events.push(decoder.decode(value))
        }
      } catch {}
    })()

    await Bun.sleep(50)

    await fetch(`${base}/api/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'rename-sse', to: 'renamed-sse' }),
    })

    await Bun.sleep(50)
    controller.abort()
    await reading

    const combined = events.join('')
    expect(combined).toContain('renamed-sse')
  })
})

describe('POST /api/screenshot', () => {
  it('writes PNG to VIEWS_DIR and returns 200', async () => {
    // 1x1 red PNG (minimal valid PNG)
    const pngBytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0,
      0, 0, 12, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 0, 0, 0,
      3, 0, 1, 24, 216, 95, 168, 0, 0, 0, 0, 73, 69, 78, 68, 174,
      66, 96, 130,
    ])
    const blob = new Blob([pngBytes], { type: 'image/png' })

    const res = await fetch(`${base}/api/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-View-Name': 'screenshot-test' },
      body: blob,
    })
    expect(res.status).toBe(200)

    const file = Bun.file(join(viewsDir, 'screenshot-test.png'))
    expect(await file.exists()).toBe(true)
    expect(file.size).toBeGreaterThan(0)
  })

  it('returns 400 without X-View-Name header', async () => {
    const res = await fetch(`${base}/api/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Blob([new Uint8Array([1, 2, 3])]),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 with empty body', async () => {
    const res = await fetch(`${base}/api/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-View-Name': 'empty-shot' },
      body: new Blob([]),
    })
    expect(res.status).toBe(400)
  })
})

describe('CORS', () => {
  it('includes Access-Control-Allow-Origin header', async () => {
    const res = await fetch(`${base}/health`)
    const origin = res.headers.get('access-control-allow-origin')
    expect(origin).toBeTruthy()
  })
})
