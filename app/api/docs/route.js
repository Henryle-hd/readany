import { listDocs, saveUpload } from '../../../lib/parse.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json(await listDocs())
}

export async function POST(req) {
  const form = await req.formData()
  const saved = []
  for (const f of form.getAll('file')) {
    if (typeof f === 'string') continue
    saved.push(await saveUpload(f.name, Buffer.from(await f.arrayBuffer())))
  }
  return Response.json({ saved })
}
