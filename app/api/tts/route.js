import { edgeCall, edgeVoices } from '../../../lib/tts.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try { return Response.json(await edgeVoices()) } catch (e) { return Response.json({ error: e.message }, { status: 502 }) }
}

export async function POST(req) {
  const { text, voice, pitch } = await req.json()
  if (!text?.trim()) return Response.json({ error: 'empty text' }, { status: 400 })
  const r = await edgeCall({ text: String(text).slice(0, 3000), voice, pitch })
  return Response.json(r, { status: r.error ? 502 : 200 })
}
