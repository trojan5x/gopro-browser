# GoPro Browser (Evercloud UI)

A gorgeous, lightweight, web-based media manager and browser for **GoPro Hero 10 Black** (and later) cameras, featuring a clean layout inspired by the Evercloud design system.

![GoPro Browser Interface Preview](https://raw.githubusercontent.com/trojan5x/gopro-browser/main/index.html) *(Deploy to GitHub Pages to view live)*

---

## 🚀 Key Features

* **Evercloud Aesthetics**: Clean, modern light-theme interface with fluid CSS layouts, smooth transitions, and distinct file-type indicators.
* **Smart Session Grouping**: Automatically groups assets by date and camera session key, allowing custom inline session renaming (saved locally in your browser).
* **Parallel Download Queue**: Manage multiple downloads with individual progress trackers and cancel support (`AbortController` powered).
* **Live Camera Control**: View battery percentage, microSD capacity, recording status, and trigger the shutter directly from your browser.
* **Interactive Media Trimmer**: Cut video clips dynamically on the timeline and export them immediately using the local proxy's `ffmpeg` wrapper.
* **Full-Screen Lightbox**: Immersive image viewer and video player supporting quick keyboard shortcuts (arrow keys for navigation, Esc to close).

---

## 🛠 How It Works

Because web browsers enforce strict CORS policies, a website cannot fetch resources directly from your GoPro's local network IP. The project handles this with a simple hybrid architecture:

```
[ Your Browser (GitHub Pages / Local) ]
                 │
                 ▼ fetch("http://localhost:8765/proxy/...")
         [ Local Python Proxy ]
                 │
                 ▼ (Bypasses CORS & pipes chunks)
          [ GoPro Hero Camera ]
```

1. **The Frontend**: Statically hosted (e.g., via GitHub Pages).
2. **The Local Proxy**: A zero-dependency Python script running on your machine on port `8765` that acts as the API bridge and streams heavy files.

---

## ⚡ Quick Start (Under 30 Seconds)

1. Open the hosted web interface: **[https://trojan5x.github.io/gopro-browser/](https://trojan5x.github.io/gopro-browser/)**
2. Start the local proxy by running this command in your Terminal (macOS) or PowerShell (Windows):
   ```bash
   curl -s https://raw.githubusercontent.com/trojan5x/gopro-browser/main/gopro-proxy.py | python3
   ```
3. Connect your GoPro to your computer using a USB-C cable and press the **Power** button on the camera.
4. Click **Connect** on the website and start browsing!

---

## 💻 Offline/Local Development

If you prefer to run the application completely offline without loading it from GitHub Pages:

1. Clone the repository:
   ```bash
   git clone https://github.com/trojan5x/gopro-browser.git
   cd gopro-browser
   ```
2. Start the proxy server:
   ```bash
   python3 gopro-proxy.py
   ```
3. Open your browser and go to: **[http://localhost:8765](http://localhost:8765)**

---

## 📦 Requirements

* **Local Machine**: Python 3.x installed (pre-installed on macOS).
* **Optional**: Install `ffmpeg` (`brew install ffmpeg` on macOS) to enable the video clip trimmer.
* **GoPro**: Hero 10 Black or later, connected via USB-C (ensure USB connection mode is set to **GoPro Connect** or **MTP**).
