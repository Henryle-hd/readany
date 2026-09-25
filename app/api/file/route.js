import fs from 'node:fs/promises'
import path from 'node:path'
import { docPath } from '../../../lib/parse.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TYPES = { pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', html: 'text/html; charset=utf-8' }

export async function GET(req) {
  const name = new URL(req.url).searchParams.get('name')
  try {
    const p = docPath(name)
    const type = TYPES[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream'
    return new Response(await fs.readFile(p), {
      headers: { 'content-type': type, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(p))}` },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
