import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const run = promisify(execFile)
const BIG = { maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60 * 1000 }

export const ROOT = /*turbopackIgnore: true*/ process.cwd()
export const DOCS_DIR = process.env.READANY_DOCS || path.join(/*turbopackIgnore: true*/ ROOT, 'docs')
const CACHE_DIR = path.join(/*turbopackIgnore: true*/ ROOT, '.cache')
const OCR_BIN = path.join(/*turbopackIgnore: true*/ CACHE_DIR, 'ocr')
const OCR_SRC = path.join(/*turbopackIgnore: true*/ ROOT, 'lib', 'ocr.swift')
const PARSER_VERSION = 5
const PAGE_CHARS = 2500

const TEXT_EXT = new Set(['txt', 'text', 'log', 'rst', 'org', 'tex', 'srt', 'vtt', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'sh', 'yml', 'yaml', 'ini', 'toml'])
const MD_EXT = new Set(['md', 'markdown', 'mdx'])
const MARKITDOWN_EXT = new Set(['pptx', 'xlsx', 'xls', 'epub', 'msg', 'ipynb', 'zip'])
const HTML_EXT = new Set(['html', 'htm', 'xhtml', 'xml', 'rss', 'atom', 'svg'])
const TEXTUTIL_EXT = new Set(['doc', 'rtf', 'rtfd', 'odt', 'wordml', 'webarchive'])
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'heic', 'tif', 'tiff', 'bmp', 'gif', 'webp'])

const hasCache = new Map()
async function has(cmd) {
  if (!hasCache.has(cmd)) hasCache.set(cmd, run('which', [cmd]).then(() => true, () => false))
  return hasCache.get(cmd)
}

export function docPath(name) {
  const p = path.join(/*turbopackIgnore: true*/ DOCS_DIR, path.basename(String(name || '')))
  if (!p.startsWith(DOCS_DIR + path.sep)) throw new Error('bad name')
  return p
}

export async function listDocs() {
  await fs.mkdir(DOCS_DIR, { recursive: true })
  const names = (await fs.readdir(DOCS_DIR)).filter(n => !n.startsWith('.'))
  const out = []
  for (const name of names) {
    const st = await fs.stat(path.join(/*turbopackIgnore: true*/ DOCS_DIR, name)).catch(() => null)
    if (st?.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs, ext: path.extname(name).slice(1).toLowerCase() })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export async function saveUpload(name, buf) {
  await fs.mkdir(DOCS_DIR, { recursive: true })
  const base = path.basename(name).replace(/[\/\\:\0]/g, '_') || 'upload'
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length)
  let final = base
  for (let i = 1; fss.existsSync(path.join(/*turbopackIgnore: true*/ DOCS_DIR, final)); i++) final = `${stem} (${i})${ext}`
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ DOCS_DIR, final), buf)
  return final
}

// ---------- parsing ----------

export async function parseDoc(name) {
  const file = docPath(name)
  const st = await fs.stat(file)
  const key = crypto.createHash('sha1').update(`${PARSER_VERSION}|${name}|${st.size}|${st.mtimeMs}`).digest('hex')
  const cacheFile = path.join(/*turbopackIgnore: true*/ CACHE_DIR, 'parsed', key + '.json')
  try { return JSON.parse(await fs.readFile(cacheFile, 'utf8')) } catch {}

  const ext = path.extname(name).slice(1).toLowerCase()
  let pages, source
  if (ext === 'pdf') {
    ({ pages, source } = await parsePdf(file))
    pages = pages.map(reflow)
  } else if (ext === 'docx') {
    const mammoth = (await import('mammoth')).default
    const { value } = await mammoth.extractRawText({ path: file })
    pages = chunk(reflow(value)); source = 'mammoth'
  } else if (IMG_EXT.has(ext)) {
    if (!(await canOcr())) throw new Error('OCR needs macOS with Xcode command line tools (swiftc).')
    pages = (await ocrImages([file])).map(reflow); source = 'macOS Vision OCR'
  } else if (TEXTUTIL_EXT.has(ext) && await has('textutil')) {
    const { stdout } = await run('textutil', ['-convert', 'txt', '-stdout', file], BIG)
    pages = chunk(reflow(stdout)); source = 'textutil'
  } else if (HTML_EXT.has(ext)) {
    pages = chunk(htmlToParas(await fs.readFile(file, 'utf8'))); source = 'html'
  } else if (ext === 'csv' || ext === 'tsv') {
    const sep = ext === 'tsv' ? '\t' : ','
    const rows = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(r => r.trim())
    pages = chunk(rows.map(r => r.split(sep).map(c => c.replace(/^"|"$/g, '').trim()).filter(Boolean).join(', ') + '.')); source = 'csv'
  } else if (MARKITDOWN_EXT.has(ext)) {
    pages = splitMarkitdown(await markitdown(file), ext); source = 'markitdown'
  } else if (MD_EXT.has(ext)) {
    pages = chunk(mdToParas(await fs.readFile(file, 'utf8'))); source = 'markdown'
  } else if (TEXT_EXT.has(ext) || await looksText(file)) {
    pages = chunk(reflow(await fs.readFile(file, 'utf8'))); source = 'text'
  } else {
    const md = await markitdown(file)
    pages = splitMarkitdown(md, ext); source = 'markitdown'
  }

  const out = {
    name, source,
    pages: pages.map(paras => ({ paras: paras.map(toSentences).filter(s => s.length) })),
  }
  await fs.mkdir(path.dirname(cacheFile), { recursive: true })
  await fs.writeFile(cacheFile, JSON.stringify(out))
  return out
}

async function parsePdf(file) {
  let pages, source
  if (await has('pdftotext')) {
    const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', file, '-'], BIG)
    pages = stdout.split('\f')
    if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop()
    source = 'pdftotext'
  } else {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)))
    pages = (await extractText(pdf, { mergePages: false })).text
    source = 'pdf.js'
  }
  // scanned pages (no text layer) -> OCR
  const empty = pages.map((t, i) => (t.replace(/\s/g, '').length < 15 ? i : -1)).filter(i => i >= 0)
  if (empty.length && (await has('pdftoppm')) && (await canOcr())) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'readany-'))
    try {
      const imgs = {}
      await pool(empty, 4, async i => {
        const prefix = path.join(tmp, `p${i}`)
        await run('pdftoppm', ['-r', '200', '-png', '-singlefile', '-f', String(i + 1), '-l', String(i + 1), file, prefix], BIG)
        imgs[i] = prefix + '.png'
      })
      const batches = []
      for (let k = 0; k < empty.length; k += 8) batches.push(empty.slice(k, k + 8))
      await pool(batches, 3, async b => {
        const texts = await ocrImages(b.map(i => imgs[i]))
        b.forEach((i, k) => { pages[i] = texts[k] || '' })
      })
      source += ` + OCR (${empty.length} page${empty.length > 1 ? 's' : ''})`
    } finally {
      fs.rm(tmp, { recursive: true, force: true })
    }
  }
  return { pages, source }
}

let ocrReady
function canOcr() {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  ocrReady ??= (async () => {
    if (fss.existsSync(OCR_BIN)) return true
    if (!(await has('swiftc'))) return false
    await fs.mkdir(CACHE_DIR, { recursive: true })
    try { await run('swiftc', ['-O', OCR_SRC, '-o', OCR_BIN], { timeout: 5 * 60 * 1000 }); return true } catch { return false }
  })()
  return ocrReady
}

async function ocrImages(files) {
  const { stdout } = await run(OCR_BIN, files, BIG)
  return JSON.parse(stdout)
}

async function markitdown(file) {
  if (await has('markitdown')) return (await run('markitdown', [file], BIG)).stdout
  if (await has('uvx')) return (await run('uvx', ['--from', 'markitdown[pptx,xlsx,xls,outlook]', 'markitdown', file], BIG)).stdout
  throw new Error('This format needs Microsoft markitdown. Install uv (brew install uv) or run: pip install markitdown')
}

async function looksText(file) {
  const fh = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(buf, 0, 4096, 0)
    return bytesRead > 0 && !buf.subarray(0, bytesRead).includes(0)
  } finally { await fh.close() }
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

// ---------- text shaping ----------

const PAGE_NUM = /^\s*(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(of|\/)\s*\d+)?\s*$/i

// raw text (hard-wrapped lines) -> array of paragraphs
function reflow(raw) {
  let t = String(raw || '').replace(/\r\n?/g, '\n').replace(/­/g, '').replace(/\t/g, ' ')
  t = t.replace(/([a-z])-\n\s*([a-z])/g, '$1$2')
  const lines = t.split('\n').map(l => l.replace(/\s+$/, ''))
  while (lines.length && (!lines[0].trim() || PAGE_NUM.test(lines[0]))) lines.shift()
  while (lines.length && (!lines.at(-1).trim() || PAGE_NUM.test(lines.at(-1)))) lines.pop()
  const maxLen = Math.max(1, ...lines.map(l => l.trim().length))
  const paras = []
  let cur = []
  const flush = () => { if (cur.length) paras.push(cur.join(' ').replace(/\s+/g, ' ').trim()); cur = [] }
  for (const line of lines) {
    const l = line.trim()
    if (!l) { flush(); continue }
    if (/^([•●▪◦\-*–]|\d{1,3}[.)])\s+/.test(l) && cur.length) flush()
    cur.push(l.replace(/^[•●▪◦]\s*/, ''))
    if ((l.length < maxLen * 0.97 && /[.!?:;]["'”’)\]]?$/.test(l)) || l.length < maxLen * 0.45) flush()
  }
  flush()
  return paras.filter(Boolean)
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
function htmlToParas(html) {
  const t = html
    .replace(/<(script|style|head|nav|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|title|header|footer|dt|dd)>|<br\s*\/?>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ''), /^#x/i.test(e) ? 16 : 10)) : ENT[e.toLowerCase()] ?? m)
  return t.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').replace(/,\s*$/, '').trim()).filter(p => /\w/.test(p))
}

function mdToParas(md) {
  const paras = []
  let cur = []
  const flush = () => { if (cur.length) paras.push(cur.join(' ').replace(/\s+/g, ' ').trim()); cur = [] }
  const inline = s => s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
  for (let line of String(md).replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const l = line.trim()
    if (!l || /^```/.test(l) || /^(-{3,}|\*{3,}|_{3,})$/.test(l)) { flush(); continue }
    if (/^\|?\s*:?-{3,}/.test(l)) continue // table separator
    if (/^#{1,6}\s/.test(l)) { flush(); paras.push(inline(l.replace(/^#+\s*/, ''))); continue }
    if (/^\|/.test(l)) {
      flush()
      const cells = l.split('|').map(c => inline(c.trim())).filter(c => c && c.toLowerCase() !== 'nan')
      if (cells.length) paras.push(cells.join(', ') + '.')
      continue
    }
    if (/^([-*+]|\d{1,3}[.)])\s+/.test(l)) { flush(); cur.push(inline(l.replace(/^([-*+]|\d{1,3}[.)])\s+/, ''))); continue }
    if (/^>\s?/.test(l)) { cur.push(inline(l.replace(/^>\s?/, ''))); continue }
    cur.push(inline(l))
  }
  flush()
  return paras.filter(p => /\w/.test(p))
}

function splitMarkitdown(md, ext) {
  let parts = null
  if (/<!--\s*Slide number:\s*\d+\s*-->/.test(md)) parts = md.split(/<!--\s*Slide number:\s*\d+\s*-->/).filter(p => p.trim())
  else if ((ext === 'xlsx' || ext === 'xls') && /^## /m.test(md)) parts = md.split(/^(?=## )/m).filter(p => p.trim())
  if (parts) return parts.flatMap(p => chunk(mdToParas(p)))
  return chunk(mdToParas(md))
}

// paragraphs -> pages of ~PAGE_CHARS
function chunk(paras) {
  const pages = []
  let cur = [], n = 0
  for (const p of paras) {
    if (n && n + p.length > PAGE_CHARS) { pages.push(cur); cur = []; n = 0 }
    cur.push(p); n += p.length
  }
  if (cur.length || !pages.length) pages.push(cur)
  return pages
}

const ABBR = /(\b(e\.g|i\.e|etc|vs|cf|al|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|No|Fig|Vol|pp|approx|Inc|Ltd|Co)\.|\b[A-Z]\.)$/
const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })
function toSentences(para) {
  const out = []
  for (const { segment } of segmenter.segment(para)) {
    const s = segment.trim()
    if (!s) continue
    // glue tiny fragments ("1.") and abbreviations ("e.g.", "Dr.") onto the next piece
    if (out.length && (out.at(-1).length < 6 || ABBR.test(out.at(-1)))) out[out.length - 1] += ' ' + s
    else out.push(s)
  }
  return out.flatMap(s => splitLong(s))
}

function splitLong(s, max = 220) {
  const parts = []
  while (s.length > max) {
    const win = s.slice(0, max)
    let cut = -1
    const re = /[,;:—–)]\s/g
    let m
    while ((m = re.exec(win))) if (m.index > max * 0.35) cut = m.index + 1
    if (cut < 0) cut = win.lastIndexOf(' ')
    if (cut < max * 0.3) cut = max
    parts.push(s.slice(0, cut).trim())
    s = s.slice(cut).trim()
  }
  if (s) parts.push(s)
  return parts
}
