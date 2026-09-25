import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'

const SCRIPT = path.join(/*turbopackIgnore: true*/ process.cwd(), 'lib', 'edge_worker.py')
let proc = null, seq = 0, buf = '', errTail = ''
const pending = new Map()

function which(cmd) { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false } }

function worker() {
  if (proc) return proc
  const [cmd, args] = which('uv')
    ? ['uv', ['run', '--no-project', '--quiet', '--with', 'edge-tts', 'python', SCRIPT]]
    : ['python3', [SCRIPT]] // needs: pip install edge-tts
  proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id) } catch {}
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', d => { errTail = (errTail + d).slice(-500) })
  const dead = () => {
    for (const r of pending.values()) r({ error: 'edge-tts worker exited. ' + errTail.trim().split('\n').pop() })
    pending.clear(); proc = null; buf = ''
  }
  proc.on('exit', dead)
  proc.on('error', dead)
  return proc
}

export function edgeCall(req, timeout = 90000) {
  return new Promise(resolve => {
    const id = ++seq
    pending.set(id, resolve)
    worker().stdin.write(JSON.stringify({ ...req, id }) + '\n')
    setTimeout(() => { if (pending.delete(id)) resolve({ error: 'edge-tts timed out (needs internet)' }) }, timeout)
  })
}

let voices = null
export async function edgeVoices() {
  if (voices) return voices
  const r = await edgeCall({ op: 'voices' })
  if (r.error) throw new Error(r.error)
  return (voices = r.voices)
}
