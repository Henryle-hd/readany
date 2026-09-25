import { parseDoc } from '../../../lib/parse.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 900

export async function GET(req) {
  const name = new URL(req.url).searchParams.get('name')
  try {
    return Response.json(await parseDoc(name))
  } catch (e) {
    const msg = e.code === 'ENOENT' ? 'File not found' : (e.stderr?.toString().trim().split('\n').pop() || e.message)
    return Response.json({ error: msg }, { status: 500 })
  }
}
