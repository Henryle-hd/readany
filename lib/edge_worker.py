# Long-lived edge-tts worker: one JSON request per stdin line, one JSON response per stdout line.
import asyncio, base64, json, sys
import edge_tts

tasks = set()

async def synth(req):
    c = edge_tts.Communicate(req["text"], req.get("voice") or "en-US-EmmaMultilingualNeural",
                             rate=req.get("rate", "+0%"), pitch=req.get("pitch", "+0Hz"), boundary="WordBoundary")
    audio, words = bytearray(), []
    async for ch in c.stream():
        if ch["type"] == "audio":
            audio += ch["data"]
        elif ch["type"] == "WordBoundary":
            words.append([ch["offset"] / 10000, ch["duration"] / 10000, ch["text"]])  # 100ns ticks -> ms
    return {"audio": base64.b64encode(bytes(audio)).decode(), "words": words}

async def handle(line):
    req = json.loads(line)
    try:
        if req.get("op") == "voices":
            res = {"voices": [{"name": v["ShortName"], "locale": v["Locale"], "gender": v["Gender"]} for v in await edge_tts.list_voices()]}
        else:
            res = await synth(req)
    except Exception as e:
        res = {"error": f"{type(e).__name__}: {e}"}
    res["id"] = req.get("id")
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()

async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 22)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while line := await reader.readline():
        if line.strip():
            t = asyncio.create_task(handle(line))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks)  # finish in-flight work on EOF

asyncio.run(main())
