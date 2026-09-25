# ReadAny

Local document reader with text-to-speech. Bun + Next.js. Everything runs on your machine.

```bash
./start.sh              # http://127.0.0.1:4747
PORT=5858 ./start.sh    # another port
./start.sh --dev        # hot reload
```

Put files in `docs/`, or drag them onto the window.

| Format | Engine | Extra install |
|---|---|---|
| PDF | poppler `pdftotext` (pdf.js fallback) | none (`brew install poppler` if missing) |
| Scanned PDF / images | macOS Vision OCR (on-device, `lib/ocr.swift`) | none |
| DOCX | mammoth | none |
| DOC / RTF / ODT | macOS `textutil` | none |
| TXT / MD / HTML / CSV / code | built-in | none |
| PPTX / XLSX / EPUB / MSG | Microsoft markitdown via `uvx` (fetched on first use, ~400 MB) | `brew install uv` |

Voice engines (switch in the player bar):

- **System voices (offline)**: the browser's Web Speech API. On macOS these are Apple's on-device voices. For better ones go to System Settings → Accessibility → Spoken Content → System Voice → Manage Voices and download a Premium or Enhanced voice.
- **Microsoft Edge neural (online)**: [edge-tts](https://github.com/rany2/edge-tts), 320+ natural voices with word-level highlighting. Runs as a small Python worker via `uv` (~9 MB, installed automatically on first use). The next sentences are pre-fetched so playback doesn't pause between them. Speed and volume change instantly.

Keys: `space` play/pause · `←/→` sentence · `[ ]` or `shift+←/→` page · `+/-` speed · `/` search · `f` follow · `Esc` stop
