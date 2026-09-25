'use client'
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'

const CPS = 15 // approx. characters spoken per second at 1x
const DEFAULTS = { rate: 1, pitch: 1, volume: 1, voice: '', engine: 'browser', edgeVoice: '', fontSize: 19, theme: 'auto', myLang: true }
const LS = {
  get(k, d) { try { const v = localStorage.getItem('readany:' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('readany:' + k, JSON.stringify(v)) } catch {} },
}
const pitchHz = p => { const hz = Math.round((p - 1) * 50); return (hz >= 0 ? '+' : '') + hz + 'Hz' }
const SPEAKABLE = /[\p{L}\p{N}]/u
const hasHL = () => typeof CSS !== 'undefined' && 'highlights' in CSS
const fmtTime = s => {
  s = Math.max(0, Math.round(s))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0')
}
const fmtSize = b => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB')
const ICON = { pdf: '📕', docx: '📘', doc: '📘', txt: '📄', md: '📝', pptx: '📙', xlsx: '📗', xls: '📗', csv: '📗', epub: '📚', html: '🌐', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', heic: '🖼️' }

export default function Home() {
  const [docs, setDocs] = useState([])
  const [doc, setDoc] = useState(null)
  const [loadingName, setLoadingName] = useState('')
  const [error, setError] = useState('')
  const [cur, setCur] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [endAt, setEndAt] = useState(null) // { end, label }
  const [voices, setVoices] = useState([])
  const [edgeVoices, setEdgeVoices] = useState(null)
  const [settings, setSettings] = useState(DEFAULTS)
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const [matchPos, setMatchPos] = useState(0)
  const [sel, setSel] = useState(null)
  const [range, setRange] = useState({ from: 1, to: 1 })
  const [showSettings, setShowSettings] = useState(false)
  const [showSide, setShowSide] = useState(true)
  const [seek, setSeek] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [sleepAt, setSleepAt] = useState(null)
  const [pageInput, setPageInput] = useState('1')

  const eng = useRef({ token: 0, idx: 0, offset: 0, playing: false, endAt: null, utt: null, edgeIdx: -1, words: [] })
  const audioRef = useRef(null)
  const ttsCache = useRef(new Map())
  const flatRef = useRef(null)
  const settingsRef = useRef(settings)
  const voicesRef = useRef([])
  const docRef = useRef(null)
  const scrollRef = useRef(null)
  const searchRef = useRef(null)
  const fileRef = useRef(null)
  const restartTimer = useRef(null)

  const flat = useMemo(() => {
    if (!doc) return null
    const sents = [], pageStart = [], cum = []
    doc.pages.forEach((pg, pi) => {
      pageStart.push(sents.length)
      pg.paras.forEach(para => para.forEach(t => sents.push({ t, p: pi })))
    })
    let c = 0
    for (const s of sents) { cum.push(c); c += s.t.length + 1 }
    return { sents, pageStart, cum, total: c }
  }, [doc])
  flatRef.current = flat
  settingsRef.current = settings

  // ---------- boot ----------
  useEffect(() => {
    setSettings({ ...DEFAULTS, ...LS.get('settings', {}) })
    audioRef.current = new Audio()
    audioRef.current.preservesPitch = true
    refresh()
    const last = LS.get('last', null)
    if (last) openDoc(last, true)
    const synth = window.speechSynthesis
    if (!synth) { setError('This browser has no speech synthesis. Use Safari, Chrome or Edge.'); return }
    const load = () => { const v = synth.getVoices(); voicesRef.current = v; setVoices(v) }
    load()
    synth.addEventListener?.('voiceschanged', load)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => { synth.cancel(); synth.removeEventListener?.('voiceschanged', load); window.removeEventListener('focus', onFocus) }
  }, [])

  useEffect(() => {
    LS.set('settings', settings)
    document.documentElement.dataset.theme = settings.theme
  }, [settings])

  // pick a good default voice
  useEffect(() => {
    if (!voices.length || (settings.voice && voices.some(v => v.voiceURI === settings.voice))) return
    const lang = (navigator.language || 'en').slice(0, 2)
    const mine = voices.filter(v => v.lang?.startsWith(lang))
    const pool = mine.length ? mine : voices
    const best = pool.find(v => /premium|enhanced|natural|neural/i.test(v.name) && v.localService)
      || pool.find(v => v.default) || pool.find(v => v.localService) || pool[0]
    setSettings(s => ({ ...s, voice: best.voiceURI }))
  }, [voices])

  useEffect(() => {
    if (settings.engine !== 'edge' || edgeVoices) return
    fetch('/api/tts').then(r => r.json()).then(v => {
      if (v.error) throw new Error(v.error)
      setEdgeVoices(v)
      if (!v.some(x => x.name === settingsRef.current.edgeVoice)) {
        const lang = (navigator.language || 'en').slice(0, 2)
        const mine = v.filter(x => x.locale.startsWith(lang))
        const best = mine.find(x => x.name === 'en-US-AvaMultilingualNeural') || mine.find(x => /Multilingual/.test(x.name)) || mine[0] || v[0]
        changeSetting('edgeVoice', best.name)
      }
    }).catch(e => { setEdgeVoices([]); setError('Edge voices unavailable (needs internet + uv): ' + e.message) })
  }, [settings.engine, edgeVoices])

  async function refresh() {
    try { setDocs(await (await fetch('/api/docs')).json()) } catch {}
  }

  async function openDoc(name, quiet) {
    stop()
    setError(''); setLoadingName(name); setDoc(null); setEndAt(null); setQuery(''); setSel(null)
    try {
      const r = await fetch('/api/doc?name=' + encodeURIComponent(name))
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Failed to open')
      const pos = LS.get('pos:' + name, 0)
      eng.current.idx = pos; eng.current.offset = 0
      setCur(pos); setFollow(true); setDoc(j)
      LS.set('last', name)
      if (window.innerWidth < 820) setShowSide(false)
    } catch (e) {
      if (!quiet) setError(`${name}: ${e.message}`)
      else LS.set('last', null)
    } finally { setLoadingName('') }
  }

  async function upload(files) {
    if (!files?.length) return
    setUploading(true)
    try {
      const fd = new FormData()
      for (const f of files) fd.append('file', f)
      const j = await (await fetch('/api/docs', { method: 'POST', body: fd })).json()
      await refresh()
      if (j.saved?.[0]) openDoc(j.saved[0])
    } catch (e) { setError('Upload failed: ' + e.message) } finally { setUploading(false) }
  }

  // ---------- speech engine ----------
  function speakAt(i, offset = 0) {
    const E = eng.current, F = flatRef.current
    const synth = window.speechSynthesis
    if (!F) return
    const token = ++E.token
    synth?.cancel()
    audioRef.current?.pause()
    const last = E.endAt != null ? Math.min(E.endAt, F.sents.length - 1) : F.sents.length - 1
    if (i > last || i < 0) {
      E.playing = false; E.offset = 0; setPlaying(false)
      E.endAt = null; setEndAt(null); clearWord()
      return
    }
    if (i !== E.idx) E.retries = 0
    E.idx = i; E.offset = offset; E.playing = true; E.startedAt = Date.now()
    setPlaying(true); setCur(i)
    const S = settingsRef.current
    if (S.engine === 'edge') return speakEdge(i, token)
    if (!synth) return
    const text = F.sents[i].t.slice(offset)
    if (!SPEAKABLE.test(text)) return speakAt(i + 1) // symbols only: speech engines go silent and never fire onend
    const u = new SpeechSynthesisUtterance(text)
    const v = voicesRef.current.find(v => v.voiceURI === S.voice)
    if (v) { u.voice = v; u.lang = v.lang }
    u.rate = S.rate; u.pitch = S.pitch; u.volume = S.volume
    u.onstart = () => { if (token === E.token) markWord(i, offset) }
    u.onboundary = e => {
      if (token !== E.token || (e.name && e.name !== 'word')) return
      E.offset = offset + e.charIndex
      markWord(i, E.offset)
    }
    u.onend = () => { if (token === E.token) speakAt(i + 1) }
    u.onerror = e => {
      if (token !== E.token || e.error === 'interrupted' || e.error === 'canceled') return
      if (e.error === 'not-allowed') { pause(); setError('Click play to allow speech.'); return }
      speakAt(i + 1)
    }
    E.utt = u // keep a reference so Chrome doesn't GC it and drop onend
    setTimeout(() => { if (token === E.token) synth.speak(u) }, 30)
  }

  // ---------- Microsoft Edge neural voices (edge-tts, online) ----------
  function edgeFetch(text) {
    const S = settingsRef.current, C = ttsCache.current
    const key = `${S.edgeVoice}|${S.pitch}|${text}`
    if (C.has(key)) { const v = C.get(key); C.delete(key); C.set(key, v); return v }
    const p = fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: S.edgeVoice, pitch: pitchHz(S.pitch) }) })
      .then(async r => {
        const j = await r.json()
        if (!r.ok || j.error) throw new Error(j.error || 'TTS failed')
        const bin = atob(j.audio), u8 = new Uint8Array(bin.length)
        for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k)
        let pos = 0
        const words = j.words.map(([t, , w]) => {
          const ci = text.indexOf(w, pos)
          if (ci < 0) return null
          pos = ci + w.length
          return { t, ci }
        }).filter(Boolean)
        return { url: URL.createObjectURL(new Blob([u8], { type: 'audio/mpeg' })), words }
      })
    p.catch(() => C.delete(key))
    C.set(key, p)
    while (C.size > 40) {
      const [k, v] = C.entries().next().value
      C.delete(k); v.then(x => URL.revokeObjectURL(x.url), () => {})
    }
    return p
  }
  function speakEdge(i, token) {
    const E = eng.current, F = flatRef.current, a = audioRef.current
    const text = F.sents[i].t
    if (!SPEAKABLE.test(text)) return speakAt(i + 1)
    E.edgeIdx = i
    E.waiting = true
    setBuffering(true)
    edgeFetch(text).then(({ url, words }) => {
      if (token !== E.token) return
      E.waiting = false; E.startedAt = Date.now()
      setBuffering(false)
      a.src = url
      E.words = words
      playEdge(token, i)
    }).catch(err => {
      if (token !== E.token) return
      E.waiting = false
      setBuffering(false); pause(); setError('Edge voice failed: ' + err.message)
    })
    // prefetch the next sentences so playback is gapless
    for (let k = 1; k <= 3; k++) {
      const j = i + k
      if (F.sents[j] && (E.endAt == null || j <= E.endAt)) edgeFetch(F.sents[j].t).catch(() => {})
    }
  }
  function playEdge(token, i) {
    const E = eng.current, a = audioRef.current, S = settingsRef.current
    a.playbackRate = S.rate; a.volume = S.volume
    a.onended = () => { if (token === E.token) speakAt(i + 1) }
    a.onerror = () => { if (token === E.token) speakAt(i + 1) }
    a.play().catch(err => { if (token === E.token && err.name !== 'AbortError') { pause(); setError('Click play to allow audio.') } })
    let last = -1
    const tick = () => {
      if (token !== E.token) return
      const ms = a.currentTime * 1000, ws = E.words
      let k = last
      while (k + 1 < ws.length && ws[k + 1].t <= ms) k++
      if (k !== last && k >= 0) { last = k; markWord(i, ws[k].ci) }
      if (!a.paused && !a.ended) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  function pause() {
    const E = eng.current
    E.token++; E.playing = false
    setBuffering(false)
    window.speechSynthesis?.cancel()
    audioRef.current?.pause()
    setPlaying(false)
  }
  function stop() {
    pause()
    eng.current.offset = 0; eng.current.endAt = null; eng.current.edgeIdx = -1
    setEndAt(null); clearWord()
  }
  function toggle() {
    const E = eng.current
    const a = audioRef.current
    if (E.playing) return pause()
    setFollow(true); setError('')
    if (settingsRef.current.engine === 'edge' && E.edgeIdx === E.idx && a?.src && a.currentTime > 0 && !a.ended) {
      const token = ++E.token // resume the paused sentence mid-way
      E.playing = true; setPlaying(true)
      playEdge(token, E.idx)
    } else speakAt(E.idx, E.offset)
  }
  function jumpTo(i, play) {
    const F = flatRef.current
    if (!F || !F.sents.length) return
    i = Math.max(0, Math.min(F.sents.length - 1, i))
    const E = eng.current
    setFollow(true)
    if (E.endAt != null && i > E.endAt) clearRange() // navigated outside the chosen range
    if (E.playing || play) speakAt(i)
    else { E.idx = i; E.offset = 0; E.edgeIdx = -1; setCur(i); clearWord() }
  }
  function restartSoon() {
    clearTimeout(restartTimer.current)
    restartTimer.current = setTimeout(() => {
      const E = eng.current
      if (E.playing) speakAt(E.idx, E.offset)
    }, 250)
  }
  function readRange(start, end, label) {
    eng.current.endAt = end
    setEndAt({ start, end, label })
    setSel(null)
    window.getSelection()?.removeAllRanges()
    setFollow(true)
    speakAt(start)
  }
  function clearRange() { eng.current.endAt = null; setEndAt(null) }

  const pageOf = i => flat?.sents[i]?.p ?? 0
  const pageEnd = p => (p + 1 < flat.pageStart.length ? flat.pageStart[p + 1] : flat.sents.length) - 1
  function gotoPage(p) {
    if (!flat) return
    p = Math.max(0, Math.min(flat.pageStart.length - 1, p))
    jumpTo(flat.pageStart[p])
    document.querySelector(`[data-page="${p}"]`)?.scrollIntoView({ block: 'start' })
  }
  function prevPage() {
    const p = pageOf(eng.current.idx)
    if (eng.current.idx - flat.pageStart[p] > 1) jumpTo(flat.pageStart[p])
    else gotoPage(p - 1)
  }
  const nextPage = () => gotoPage(pageOf(eng.current.idx) + 1)

  // ---------- highlighting ----------
  function markWord(i, ci) {
    if (!hasHL()) return
    const node = docRef.current?.querySelector(`[data-i="${i}"]`)?.firstChild
    if (!node) return
    const txt = node.textContent
    const start = Math.min(ci, txt.length)
    const m = /^\S+/.exec(txt.slice(start))
    const r = new Range()
    r.setStart(node, start)
    r.setEnd(node, Math.min(txt.length, start + (m ? m[0].length : 0)))
    CSS.highlights.set('ra-word', new Highlight(r))
  }
  function clearWord() { if (hasHL()) CSS.highlights.delete('ra-word') }

  useEffect(() => {
    const root = docRef.current
    if (!root || !flat) return
    root.querySelector('.cur')?.classList.remove('cur')
    const el = root.querySelector(`[data-i="${cur}"]`)
    if (el) {
      el.classList.add('cur')
      if (follow) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    setPageInput(String(pageOf(cur) + 1))
    if (settings.engine === 'edge' && !eng.current.playing && flat.sents[cur]) edgeFetch(flat.sents[cur].t).catch(() => {})
    LS.set('pos:' + doc.name, cur)
    LS.set('prog:' + doc.name, flat.sents.length ? cur / flat.sents.length : 0)
  }, [cur, doc, follow])

  // search
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!flat || q.length < 2) return []
    const r = []
    flat.sents.forEach((s, i) => { if (s.t.toLowerCase().includes(q)) r.push(i) })
    return r
  }, [flat, query])
  useEffect(() => {
    const root = docRef.current
    if (!root) return
    root.querySelectorAll('.hit').forEach(el => el.classList.remove('hit', 'hit-now'))
    matches.slice(0, 5000).forEach(i => root.querySelector(`[data-i="${i}"]`)?.classList.add('hit'))
    setMatchPos(-1)
  }, [matches])
  function gotoMatch(d) {
    if (!matches.length) return
    const n = matchPos < 0 ? (d > 0 ? 0 : matches.length - 1) : (matchPos + d + matches.length) % matches.length
    setMatchPos(n)
    const root = docRef.current
    root.querySelector('.hit-now')?.classList.remove('hit-now')
    const el = root.querySelector(`[data-i="${matches[n]}"]`)
    el?.classList.add('hit-now')
    setFollow(false)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // watchdog: if speech silently dies (no onend), retry the sentence once, then move on
  useEffect(() => {
    const t = setInterval(() => {
      const E = eng.current
      if (!E.playing || E.waiting || Date.now() - (E.startedAt || 0) < 2500) return
      let stalled
      if (settingsRef.current.engine === 'edge') {
        const a = audioRef.current
        stalled = a && a.paused && !a.ended
      } else {
        const s = window.speechSynthesis
        stalled = s && !s.speaking && !s.pending
      }
      if (!stalled) return
      E.startedAt = Date.now()
      if ((E.retries = (E.retries || 0) + 1) <= 1) speakAt(E.idx, E.offset)
      else speakAt(E.idx + 1)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // sleep timer
  useEffect(() => {
    if (!sleepAt) return
    const t = setTimeout(() => { pause(); setSleepAt(null) }, sleepAt - Date.now())
    return () => clearTimeout(t)
  }, [sleepAt])

  // keyboard
  useEffect(() => {
    const onKey = e => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return
      if (!flatRef.current) return
      const k = e.key
      if (k === ' ') { e.preventDefault(); toggle() }
      else if (k === 'ArrowRight' && e.shiftKey || k === ']') { e.preventDefault(); nextPage() }
      else if (k === 'ArrowLeft' && e.shiftKey || k === '[') { e.preventDefault(); prevPage() }
      else if (k === 'ArrowRight') { e.preventDefault(); jumpTo(eng.current.idx + 1) }
      else if (k === 'ArrowLeft') { e.preventDefault(); jumpTo(eng.current.idx - 1) }
      else if (k === '+' || k === '=') changeSetting('rate', Math.min(3, +(settingsRef.current.rate + 0.1).toFixed(2)), true)
      else if (k === '-' || k === '_') changeSetting('rate', Math.max(0.5, +(settingsRef.current.rate - 0.1).toFixed(2)), true)
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (k === 'f') setFollow(f => !f)
      else if (k === 'Escape') { stop(); setSel(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function changeSetting(k, v, restart) {
    setSettings(s => ({ ...s, [k]: v }))
    settingsRef.current = { ...settingsRef.current, [k]: v }
    const a = audioRef.current
    if (settingsRef.current.engine === 'edge' && a && (k === 'rate' || k === 'volume')) {
      if (k === 'rate') a.playbackRate = v; else a.volume = v // applied live, no re-synthesis
      return
    }
    if (restart) restartSoon()
  }

  // ---------- doc interactions ----------
  function spanOf(node) {
    if (!node) return null
    let el = node.nodeType === 3 ? node.parentElement : node
    let s = el?.closest?.('[data-i]')
    if (!s && node.nodeType === 3) s = node.previousElementSibling || node.nextElementSibling
    if (!s && el?.matches?.('p')) s = el.querySelector('[data-i]')
    return s?.dataset?.i != null ? +s.dataset.i : null
  }
  function onDocClick(e) {
    const s = window.getSelection()
    if (s && !s.isCollapsed) return
    const el = e.target.closest('[data-i]')
    if (el) { setSel(null); jumpTo(+el.dataset.i, true) }
  }
  function onDocMouseUp() {
    setTimeout(() => {
      const s = window.getSelection()
      if (!s || s.isCollapsed || !docRef.current?.contains(s.anchorNode)) { setSel(null); return }
      const a = spanOf(s.anchorNode), b = spanOf(s.focusNode)
      if (a == null || b == null) return
      const r = s.getRangeAt(0).getBoundingClientRect()
      setSel({ start: Math.min(a, b), end: Math.max(a, b), x: r.left + r.width / 2, y: r.top })
    }, 0)
  }

  // ---------- derived ----------
  const nPages = flat?.pageStart.length || 0
  const curPage = pageOf(cur)
  const shownIdx = seek ?? cur
  const remainSecs = flat ? (flat.total - (flat.cum[shownIdx] || 0)) / (CPS * settings.rate) : 0
  const pct = flat?.sents.length ? (shownIdx / Math.max(1, flat.sents.length - 1)) * 100 : 0
  const lang = typeof navigator !== 'undefined' ? (navigator.language || 'en').slice(0, 2) : 'en'
  const voiceList = useMemo(() => {
    const list = settings.myLang ? voices.filter(v => v.lang?.startsWith(lang) || v.voiceURI === settings.voice) : voices
    return [...(list.length ? list : voices)].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
  }, [voices, settings.myLang, settings.voice, lang])
  const edgeVoiceList = useMemo(() => {
    const all = edgeVoices || []
    const list = settings.myLang ? all.filter(v => v.locale.startsWith(lang) || v.name === settings.edgeVoice) : all
    return [...(list.length ? list : all)].sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))
  }, [edgeVoices, settings.myLang, settings.edgeVoice, lang])

  return (
    <div
      className={'app' + (showSide ? '' : ' noside')}
      style={{ '--fs': settings.fontSize + 'px' }}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={e => { if (!e.relatedTarget) setDragging(false) }}
      onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files) }}
    >
      {dragging && <div className="dropzone">Drop to add to library</div>}

      <aside className="side">
        <div className="brand">
          <span className="logo">◉</span> ReadAny
          <button className="icon ghost only-mobile" onClick={() => setShowSide(false)} title="Close">✕</button>
        </div>
        <div className="side-actions">
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? 'Adding…' : '+ Add files'}</button>
          <button className="btn ghost" onClick={refresh} title="Rescan docs folder">↻</button>
          <input ref={fileRef} type="file" multiple hidden onChange={e => { upload(e.target.files); e.target.value = '' }} />
        </div>
        <div className="hint">or drop files into <code>docs/</code> / onto this window</div>
        <ul className="doclist">
          {docs.map(d => {
            const prog = LS.get('prog:' + d.name, 0)
            return (
              <li key={d.name} className={doc?.name === d.name ? 'active' : ''} onClick={() => openDoc(d.name)} title={d.name}>
                <span className="dicon">{ICON[d.ext] || '📄'}</span>
                <span className="dname">{d.name}</span>
                <span className="dmeta">{loadingName === d.name ? 'opening…' : fmtSize(d.size)}{prog > 0.01 && loadingName !== d.name ? ` · ${Math.round(prog * 100)}%` : ''}</span>
                {prog > 0 && <span className="dprog" style={{ width: prog * 100 + '%' }} />}
              </li>
            )
          })}
          {!docs.length && <li className="empty">No documents yet.</li>}
        </ul>

        {flat && nPages > 1 && (
          <>
            <div className="side-title">Pages</div>
            <div className="pagegrid">
              {flat.pageStart.map((_, p) => (
                <button key={p} className={'pg' + (p === curPage ? ' now' : p < curPage ? ' done' : '') + (endAt && p >= pageOf(endAt.start) && p <= pageOf(endAt.end) ? ' inrange' : '')} onClick={() => gotoPage(p)}>{p + 1}</button>
              ))}
            </div>
          </>
        )}
      </aside>

      <main className="main" ref={scrollRef} onWheel={() => follow && playing && setFollow(false)} onTouchMove={() => follow && playing && setFollow(false)}>
        <header className="top">
          <button className="icon ghost" onClick={() => setShowSide(s => !s)} title="Toggle library">☰</button>
          <div className="title" title={doc?.name}>{doc ? doc.name : 'ReadAny'}{doc && <span className="src">{doc.source}</span>}</div>
          {flat && (
            <>
              <form className="pagebox" onSubmit={e => { e.preventDefault(); gotoPage(+pageInput - 1) }}>
                <span>Page</span>
                <input value={pageInput} onChange={e => setPageInput(e.target.value.replace(/\D/g, ''))} onBlur={() => setPageInput(String(curPage + 1))} inputMode="numeric" />
                <span>/ {nPages}</span>
              </form>
              <div className="search">
                <input ref={searchRef} placeholder="Search  ( / )" value={query} onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1) } else if (e.key === 'Escape') { setQuery(''); e.target.blur() } }} />
                {query.trim().length >= 2 && (
                  <>
                    <span className="count">{matches.length ? `${Math.max(0, matchPos) + 1}/${matches.length}` : '0'}</span>
                    <button className="icon ghost" onClick={() => gotoMatch(-1)} title="Previous">↑</button>
                    <button className="icon ghost" onClick={() => gotoMatch(1)} title="Next">↓</button>
                    {matches.length > 0 && <button className="icon ghost" onClick={() => jumpTo(matches[Math.max(0, matchPos)], true)} title="Read from this match">▶</button>}
                  </>
                )}
              </div>
            </>
          )}
        </header>

        {flat && (
          <div className="modes">
            <span className="lbl">Read:</span>
            <button className="chip" onClick={() => { clearRange(); jumpTo(0, true) }}>From start</button>
            <button className="chip" onClick={toggle}>{playing ? 'Pause' : 'Continue'}</button>
            <button className="chip" onClick={() => readRange(flat.pageStart[curPage], pageEnd(curPage), `page ${curPage + 1}`)}>This page</button>
            <form className="chip range" onSubmit={e => {
              e.preventDefault()
              const a = Math.max(1, Math.min(nPages, +range.from || 1)), b = Math.max(a, Math.min(nPages, +range.to || a))
              readRange(flat.pageStart[a - 1], pageEnd(b - 1), a === b ? `page ${a}` : `pages ${a}–${b}`)
            }}>
              Pages <input value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value.replace(/\D/g, '') }))} />
              – <input value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value.replace(/\D/g, '') }))} />
              <button type="submit">▶</button>
            </form>
            <span className="lbl muted">or select text · click any sentence</span>
            {endAt && <span className="chip on">Only {endAt.label} <button onClick={clearRange} title="Keep reading to the end">✕</button></span>}
          </div>
        )}

        {error && <div className="error" onClick={() => setError('')}>{error}</div>}

        {!doc && !loadingName && (
          <div className="welcome">
            <h1>Open a document to start listening</h1>
            <p>PDF (incl. scanned), Word, TXT, Markdown, PowerPoint, Excel, EPUB, HTML, images. Everything runs on this machine.</p>
            <button className="btn big" onClick={() => fileRef.current?.click()}>+ Add files</button>
          </div>
        )}
        {loadingName && !doc && <div className="welcome"><div className="spinner" /><p>Reading <b>{loadingName}</b>… (scanned pages are OCR&apos;d, this can take a moment)</p></div>}

        {doc && (
          <article className="doc" ref={docRef} onClick={onDocClick} onMouseUp={onDocMouseUp}>
            <DocBody doc={doc} />
            {!flat.sents.length && <p className="empty">No readable text found in this document.</p>}
          </article>
        )}

        {sel && (
          <div className="selpop" style={{ left: sel.x, top: sel.y }}>
            <button onMouseDown={e => e.preventDefault()} onClick={() => readRange(sel.start, sel.end, 'selection')}>▶ Read selection</button>
            <button onMouseDown={e => e.preventDefault()} onClick={() => { clearRange(); setSel(null); window.getSelection()?.removeAllRanges(); jumpTo(sel.start, true) }}>Read from here</button>
          </div>
        )}

        {doc && !follow && (
          <button className="followbtn" onClick={() => { setFollow(true); docRef.current?.querySelector('.cur')?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }}>⌖ Back to reading position</button>
        )}
      </main>

      <footer className="player">
        <div className="seekrow">
          <span className="time">p.{flat ? pageOf(shownIdx) + 1 : 0}</span>
          <div className="seekwrap">
            <div className="seekfill" style={{ width: pct + '%' }} />
            <input type="range" className="seek" min={0} max={Math.max(0, (flat?.sents.length || 1) - 1)} value={shownIdx} disabled={!flat}
              onChange={e => setSeek(+e.target.value)}
              onPointerUp={() => { if (seek != null) { jumpTo(seek); setSeek(null) } }}
              onKeyUp={() => { if (seek != null) { jumpTo(seek); setSeek(null) } }} />
          </div>
          <span className="time">{Math.round(pct)}% · −{fmtTime(remainSecs)}</span>
        </div>
        <div className="controls">
          <div className="left">
            <button className="icon" onClick={prevPage} disabled={!flat} title="Previous page ( [ )">⏮</button>
            <button className="icon" onClick={() => jumpTo(eng.current.idx - 1)} disabled={!flat} title="Previous sentence ( ← )">⏪</button>
            <button className="play" onClick={toggle} disabled={!flat} title="Play / pause (space)">{buffering ? <span className="buf" /> : playing ? '❚❚' : '▶'}</button>
            <button className="icon" onClick={() => jumpTo(eng.current.idx + 1)} disabled={!flat} title="Next sentence ( → )">⏩</button>
            <button className="icon" onClick={nextPage} disabled={!flat} title="Next page ( ] )">⏭</button>
            <button className="icon" onClick={stop} disabled={!flat} title="Stop (Esc)">■</button>
          </div>
          <div className="right">
            <label className="speed" title="Speed (+ / −)">
              <input type="range" min={0.5} max={3} step={0.05} value={settings.rate} onChange={e => changeSetting('rate', +e.target.value, true)} />
              <span>{settings.rate.toFixed(2)}×</span>
            </label>
            <select className="engine" value={settings.engine} onChange={e => changeSetting('engine', e.target.value, true)} title="Voice engine">
              <option value="browser">System voices (offline)</option>
              <option value="edge">Microsoft Edge neural (online)</option>
            </select>
            {settings.engine === 'edge' ? (
              <select className="voice" value={settings.edgeVoice} onChange={e => changeSetting('edgeVoice', e.target.value, true)} title="Voice">
                {!edgeVoices && <option>Loading voices…</option>}
                {edgeVoiceList.map(v => <option key={v.name} value={v.name}>{v.name.replace(/^[a-z]{2,3}-[A-Za-z]{2,4}-/, '').replace(/Neural$/, '')} · {v.locale} · {v.gender[0]}</option>)}
              </select>
            ) : (
              <select className="voice" value={settings.voice} onChange={e => changeSetting('voice', e.target.value, true)} title="Voice">
                {voiceList.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}{v.localService ? '' : ' (online)'}</option>)}
              </select>
            )}
            <button className={'icon' + (follow ? ' on' : '')} onClick={() => setFollow(f => !f)} title="Auto-scroll with reading (f)">⌖</button>
            <button className={'icon' + (showSettings ? ' on' : '')} onClick={() => setShowSettings(s => !s)} title="Settings">⚙</button>
          </div>
        </div>
        {showSettings && (
          <div className="settings">
            <label>Pitch <input type="range" min={0.5} max={2} step={0.05} value={settings.pitch} onChange={e => changeSetting('pitch', +e.target.value, true)} /> <span>{settings.pitch.toFixed(2)}</span></label>
            <label>Volume <input type="range" min={0} max={1} step={0.05} value={settings.volume} onChange={e => changeSetting('volume', +e.target.value, true)} /> <span>{Math.round(settings.volume * 100)}%</span></label>
            <label>Text size <input type="range" min={14} max={30} step={1} value={settings.fontSize} onChange={e => changeSetting('fontSize', +e.target.value)} /> <span>{settings.fontSize}px</span></label>
            <label>Theme
              <select value={settings.theme} onChange={e => changeSetting('theme', e.target.value)}>
                <option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option><option value="sepia">Sepia</option>
              </select>
            </label>
            <label>Sleep timer
              <select value={sleepAt ? 'on' : ''} onChange={e => setSleepAt(e.target.value ? Date.now() + +e.target.value * 60000 : null)}>
                <option value="">{sleepAt ? `Stops at ${new Date(sleepAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (cancel)` : 'Off'}</option>
                {[10, 15, 30, 45, 60, 90].map(m => <option key={m} value={m}>{m} min</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={settings.myLang} onChange={e => changeSetting('myLang', e.target.checked)} /> Only voices for my language</label>
            {doc && <a className="orig" href={'/api/file?name=' + encodeURIComponent(doc.name)} target="_blank" rel="noreferrer">Open original file ↗</a>}
            <p className="tip">Better voices (free, on-device): macOS System Settings → Accessibility → Spoken Content → System Voice → Manage Voices → download a <b>Premium</b> or <b>Enhanced</b> voice, then reload this page. Or switch the engine to <b>Microsoft Edge neural</b> (edge-tts): natural voices in 70+ languages, streamed online.</p>
            <p className="tip">Keys: space play/pause · ←/→ sentence · [ ] or shift+←/→ page · +/− speed · / search · f follow · Esc stop</p>
          </div>
        )}
      </footer>
    </div>
  )
}

// Rendered once per document; highlighting is done by toggling classes directly for speed.
const DocBody = memo(function DocBody({ doc }) {
  let i = 0
  return doc.pages.map((pg, pi) => (
    <section key={pi} className="page" data-page={pi}>
      {doc.pages.length > 1 && <div className="pageno"><span>Page {pi + 1}</span></div>}
      {!pg.paras.length && <p className="empty">(no text on this page)</p>}
      {pg.paras.map((para, k) => (
        <p key={k}>
          {para.map(t => {
            const id = i++
            return <Fragment key={id}><span data-i={id}>{t}</span>{' '}</Fragment>
          })}
        </p>
      ))}
    </section>
  ))
})
