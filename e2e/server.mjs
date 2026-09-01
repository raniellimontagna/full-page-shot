// Static file server for the e2e fixtures.
//
// A hand-rolled server rather than `vite preview`: preview refuses to serve a
// plain directory with no build manifest, and this one also needs to serve a
// real image over the network (so `loading="lazy"` genuinely defers) and to
// send no-cache headers, so that a second capture of the same fixture re-runs
// the same lazy-loading work rather than replaying a warm cache.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript',
}

createServer((req, res) => {
  const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^(\.\.[/\\])+/, '')
  readFile(join(root, path))
    .then((body) => {
      res.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(body)
    })
    .catch(() => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
}).listen(5199, '127.0.0.1', () => {
  console.log('fixtures on http://localhost:5199')
})
