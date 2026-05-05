#!/usr/bin/env python3
"""
Render lightning_logo.html into a 12-second seamless-loop MP4.

Technique: pause all CSS animations and seek via negative animation-delay,
screenshot each frame, then encode with ffmpeg.
"""

import os
import shutil
import subprocess
import sys
from playwright.sync_api import sync_playwright

FPS = 30
DURATION = 12          # seconds — exactly 3x the 4-second animation cycle
WIDTH, HEIGHT = 1280, 720  # 720p, 16:9
TOTAL_FRAMES = FPS * DURATION  # 360

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML_PATH = os.path.join(ROOT, "lightning_logo.html")
FRAMES_DIR = os.path.join(ROOT, "_frames")
OUTPUT = os.path.join(ROOT, "sdstrike_lightning.mp4")


def render_frames():
    os.makedirs(FRAMES_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT})
        page.goto(f"file://{HTML_PATH}")
        page.wait_for_timeout(500)

        for i in range(TOTAL_FRAMES):
            t = i / FPS
            # Pause every animation and seek to time t
            page.evaluate(f"""(() => {{
                let el = document.getElementById('fc');
                if (!el) {{ el = document.createElement('style'); el.id = 'fc'; document.head.appendChild(el); }}
                el.textContent = `
                    *, *::before, *::after {{
                        animation-play-state: paused !important;
                        animation-delay: -{t:.6f}s !important;
                    }}
                `;
            }})()""")
            page.wait_for_timeout(30)
            page.screenshot(path=os.path.join(FRAMES_DIR, f"f{i:04d}.png"))

            if (i + 1) % 30 == 0 or i == 0:
                print(f"  frame {i + 1}/{TOTAL_FRAMES}  ({t:.1f}s)", flush=True)

        browser.close()
    print("All frames captured.")


def encode_video():
    print(f"Encoding {OUTPUT} ...")
    subprocess.run([
        "ffmpeg", "-y",
        "-framerate", str(FPS),
        "-i", os.path.join(FRAMES_DIR, "f%04d.png"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "18",
        "-preset", "slow",
        "-movflags", "+faststart",
        OUTPUT,
    ], check=True)
    print(f"Done → {OUTPUT}")


def cleanup():
    shutil.rmtree(FRAMES_DIR, ignore_errors=True)
    print("Cleaned up frame cache.")


if __name__ == "__main__":
    render_frames()
    encode_video()
    cleanup()
