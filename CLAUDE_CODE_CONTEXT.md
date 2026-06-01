# GoPro Browser — Claude Code Context

## What This Project Is

A single-HTML-file media browser for GoPro Hero 10 Black, served via a Python proxy script.
The goal: plug GoPro into Mac via USB-C, press power, open browser, browse and download media.

The app is also designed to work when `gopro-browser.html` is hosted publicly (GitHub Pages, CDN,
or opened directly as a `file://` URL). The proxy always runs locally on the user's machine.

GitHub repo: https://github.com/trojan5x/gopro-browser

GoPro Hero 10 exposes an HTTP API server over USB Ethernet (NCM).
This is the official OpenGoPro v2.0 API — MIT licensed, documented at https://gopro.github.io/OpenGoPro/

---

## Files In This Directory

- `gopro-browser.html` — the full single-page app UI (self-contained, no build step)
- `gopro-proxy.py` — Python 3 proxy server (stdlib only, no pip installs needed)
- `CLAUDE_CODE_CONTEXT.md` — this file

---

## CRITICAL: GoPro IP Address

**The documented IP `10.5.5.9` is NOT always correct.**

The tested firmware (H21.01.01.62.00) assigns the camera via DHCP — it appeared at `172.27.123.51`.
`GOPRO_BASE` in `gopro-proxy.py` is currently set to `http://172.27.123.51:8080`.

If the camera is unreachable, check the actual IP:
```bash
arp -a | grep -i gopro
# or check System Settings → Network for the NCM interface IP
```

---

## CRITICAL: Camera Info Endpoint Fallback

`/gopro/camera/info` returns **404** on this firmware. Always try both:
1. `/gopro/camera/info` (OpenGoPro v2, newer firmware)
2. `/gp/gpControl/info` (legacy, works on H21.01.01.62.00)

This fallback is implemented everywhere in the app that calls camera info.

---

## Architecture

```
gopro-browser.html  (any origin: file://, GitHub Pages, localhost)
  ↓ fetch("http://localhost:8765/proxy/...")
gopro-proxy.py  (always runs locally on user's machine, port 8765)
  ↓ strips /proxy prefix, forwards with Range headers
GoPro at http://172.27.123.51:8080
```

### Proxy endpoints

| Route | Purpose |
|---|---|
| `GET /` | Serves `gopro-browser.html` |
| `GET /info` | Returns `{local_url, gopro_url, port, ffmpeg: bool}` |
| `GET /proxy/*` | Forwards to GoPro, streams response in 256KB chunks, adds CORS headers |
| `GET /clip?path=&start=&duration=` | Runs ffmpeg to extract a clip, streams back MP4 |
| `GET /proxy-download` | Serves `gopro-proxy.py` itself as a download |
| `OPTIONS *` | CORS preflight — returns 204 |

### Key JS constants

```js
const PROXY_ORIGIN = 'http://localhost:8765';
const BASE_URL = PROXY_ORIGIN + '/proxy';  // all GoPro API calls go here
```

`BASE_URL` is absolute so the HTML works from any origin.

---

## How To Run

```bash
python3 gopro-proxy.py
# Then open http://localhost:8765 OR open gopro-browser.html directly in Chrome
```

Or one-liner (fetches from GitHub):
```bash
curl -s https://raw.githubusercontent.com/trojan5x/gopro-browser/main/gopro-proxy.py | python3
```

---

## Splash Screen / Onboarding Flow

The HTML shows a splash screen when loaded. It auto-detects in the background:
1. **Proxy check** — `GET /info` with 1.5s timeout. If found, marks step 1 done (gold checkmark).
2. **Camera check** — tries `/gopro/camera/info` then `/gp/gpControl/info`. If found, marks step 2 done and enters the app.

If proxy is not running → shows step 1 with copy-able one-liner command.
If proxy is running but camera not found → shows step 2 error "plug in via USB-C and press power".

The button label changes dynamically: "I've started the proxy →" → "Check camera →" → "Try again →".

---

## Key OpenGoPro HTTP Endpoints Used

All via GET:

| Purpose | Endpoint |
|---|---|
| Camera info (new) | `/gopro/camera/info` |
| Camera info (legacy fallback) | `/gp/gpControl/info` |
| Camera state | `/gopro/camera/state` |
| Media list | `/gopro/media/list` |
| Thumbnail | `/gopro/media/thumbnail?path=100GOPRO/GX010001.MP4` |
| Download file | `/videos/DCIM/100GOPRO/GX010001.MP4` |
| Start recording | `/gopro/camera/shutter/start` |
| Stop recording | `/gopro/camera/shutter/stop` |
| Keep-alive | `/gopro/camera/keep_alive` |
| HiLight tag | `/gopro/media/hilight/file?path=...&ms=...` |
| Delete file | `/gopro/media/delete/file?path=...` |

Media list response:
```json
{
  "media": [{
    "d": "100GOPRO",
    "fs": [
      { "n": "GX010001.MP4", "cre": "1718000000", "mod": "1718000000", "s": "104857600", "glrv": "1234" },
      { "n": "GOPR0001.JPG", "cre": "1718000001", "mod": "1718000001", "s": "5242880" }
    ]
  }]
}
```
Fields: `n` = filename, `cre` = created (unix epoch), `s` = size bytes, `glrv` = LRV proxy file size (videos only)

---

## GoPro Filename Conventions

```
GX{CC}{SSSS}.MP4   — chaptered video (CC=chapter 01+, SSSS=4-digit session)
GX{CC}{SSSS}.LRV   — low-res proxy for above (same session/chapter numbers)
GOPR{SSSS}.JPG     — photo
GP{CC}{SSSS}.JPG   — burst/timelapse photo (chaptered)
```

Sessions are grouped by the 4-digit session number + creation date. Names persist in `localStorage`
keyed as `gopro_session_names` → `{session4digit}_{YYYY-MM-DD}`.

---

## Features Implemented

- **Grid / List / Grouped / Session drill-down** view modes
- **Session grouping** — cards with stacked shadow, date headers, file counts
- **Inline session naming** — click name to edit, saved to localStorage (survives disconnect/reconnect)
- **Download queue** — sequential background downloads, progress bars, AbortController cancel
- **Live camera status** — battery %, recording state, camera mode polled every 4s
- **Keep-alive** — pings GoPro every 2.5s to prevent sleep
- **Shutter control** — Start/Stop recording button
- **LRV toggle** — stream low-res proxy instead of full file
- **Clip trimmer** — set start + duration, export via ffmpeg (`brew install ffmpeg`)
- **Photo lightbox** — full-screen view
- **HiLight tagging** — tag current moment during video playback
- **Storage visualizer** — bar showing used/free in sidebar
- **Settings modal**, **pre-ride checklist modal**, **share/QR modal**
- **Manifest export** — CSV of all media metadata
- **Bulk delete / bulk download** — multi-select with checkboxes
- **Search + filter** — by type (video/photo/LRV), sort by date/name/size

---

## Things NOT To Change

- Single-file HTML approach — keep everything in `gopro-browser.html`
- Python stdlib-only for `gopro-proxy.py` — no `pip install`
- Port `8765`
- Dark UI: Inter + JetBrains Mono fonts, amber accent `#f5a623`, dark bg `#080808`
- `BASE_URL` must remain an absolute URL (`http://localhost:8765/proxy`) so the HTML works from any origin

---

## Notes on Hero 10 USB Behaviour

- Hero 10 does NOT mount as a disk drive on Mac (unlike Hero 8/9)
- Shows up as a USB Ethernet (NCM) adapter — IP assigned via DHCP (not always `10.5.5.9`)
- HTTP API starts automatically when camera powers on with USB plugged in
- USB also powers the camera — runs indefinitely without battery
- No BLE command to enter USB mode — physical power button only
- MTP mode and GoPro Connect mode run simultaneously (MTP unreliable on Mac)
- Firmware H21.01.01.62.00: camera info only available at `/gp/gpControl/info`
- Video files can be 4GB+ — proxy must stream in chunks (256KB), never buffer entire file

---

## Verified Working

1. `python3 gopro-proxy.py` starts cleanly on port 8765
2. `curl http://localhost:8765/info` returns JSON
3. `curl http://localhost:8765/proxy/gp/gpControl/info` returns camera info (200)
4. `/gopro/camera/info` returns 404 on this firmware — fallback to legacy is required
5. Media grid loads, thumbnails render, video streaming works
6. Splash screen correctly detects proxy + camera and auto-advances
