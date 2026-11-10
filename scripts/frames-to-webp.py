#!/usr/bin/env python3
"""Encode captured frames into a small animated WebP.

Usage: frames-to-webp.py <frames.json> <out.webp> [width] [quality]
frames.json is {"frames": [{"file": path, "ms": duration}], "pointer": {...}} (or just the
list of frames). Identical consecutive frames are merged, which is where most of the size
saving comes from.

Input injected through the DevTools Protocol draws no mouse pointer in screenshots, so
"pointer" carries the recorded path (CSS pixels): an I-beam is painted over the source
text area and an arrow elsewhere, with a short ring where a click happened.
"""
import bisect
import json
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

data = json.load(open(sys.argv[1]))
frames = data["frames"] if isinstance(data, dict) else data
pointer = data.get("pointer") if isinstance(data, dict) else None
out = sys.argv[2]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 960
quality = int(sys.argv[4]) if len(sys.argv) > 4 else 72
CLICK_MS = 350
HOLD_MS = 500  # how long a modifier badge shows before and after a modified click
MODIFIERS = {4: "\u2318", 2: "Ctrl", 1: "Alt"}  # CDP bits: Meta, Ctrl, Alt


def badge_font(size):
    for name in ("/System/Library/Fonts/SFNS.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def same(a, b):
    # Ignore sub-visible noise so idle moments collapse into one long frame.
    mask = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
    return mask.getbbox() is None


def outlined(draw, shape, points, s):
    """Draw a black shape with a white outline, like the system pointer."""
    if shape == "polygon":
        draw.polygon(points, fill="black", outline="white", width=max(1, round(1.2 * s)))
    else:
        for a, b in points:
            draw.line([a, b], fill="white", width=max(3, round(3.2 * s)))
        for a, b in points:
            draw.line([a, b], fill="black", width=max(1, round(1.2 * s)))


def paint(image, t):
    s = image.width / pointer["width"]  # image pixels per CSS pixel
    track = pointer["track"]
    i = max(0, bisect.bisect_right([p["t"] for p in track], t) - 1)
    x, y = track[i]["x"], track[i]["y"] - pointer["top"]
    px, py = x * s, y * s
    draw = ImageDraw.Draw(image)
    for click in pointer["clicks"]:
        age = t - click["t"]
        if 0 <= age < CLICK_MS:
            r = (7 + 10 * age / CLICK_MS) * s
            cx, cy = click["x"] * s, (click["y"] - pointer["top"]) * s
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(0, 122, 204), width=max(2, round(2 * s)))
    s *= 1.25  # the clips are scaled down, so draw the pointer a little larger than life
    # Name the held modifier for Cmd/Ctrl-clicks, which otherwise look like plain clicks.
    for click in pointer["clicks"]:
        held = [label for bit, label in MODIFIERS.items() if click.get("modifiers", 0) & bit]
        if held and -HOLD_MS <= t - click["t"] < HOLD_MS:
            font = badge_font(round(11 * s))
            label = "+".join(held)
            x0, y0 = px + 14 * s, py + 14 * s
            box = draw.textbbox((x0, y0), label, font=font)
            pad = 3 * s
            draw.rounded_rectangle([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], radius=3 * s,
                                   fill=(37, 37, 38), outline=(200, 200, 200), width=max(1, round(s * .8)))
            draw.text((x0, y0), label, font=font, fill="white")
    text = pointer.get("text")
    over_text = text and text["left"] <= x <= text["right"] and text["top"] - pointer["top"] <= y <= text["bottom"] - pointer["top"]
    if over_text:
        h, w = 8 * s, 2.5 * s
        outlined(draw, "lines", [((px, py - h), (px, py + h)), ((px - w, py - h), (px + w, py - h)),
                                 ((px - w, py + h), (px + w, py + h))], s)
    else:
        arrow = [(0, 0), (0, 16), (4, 12.5), (7, 19), (9.5, 18), (6.5, 11.5), (11.5, 11.5)]
        outlined(draw, "polygon", [(px + ax * s, py + ay * s) for ax, ay in arrow], s)


images, durations = [], []
for k, frame in enumerate(frames):
    image = Image.open(frame["file"]).convert("RGB")
    if pointer:
        paint(image, pointer["times"][k])
    height = round(image.height * width / image.width)
    image = image.resize((width, height), Image.LANCZOS)
    if images and same(images[-1], image):
        durations[-1] += frame["ms"]
    else:
        images.append(image)
        durations.append(frame["ms"])

images[0].save(out, save_all=True, append_images=images[1:], duration=durations, loop=0,
               quality=quality, method=6, lossless=False,
               # Encode only what changed between frames; roughly a third of the size.
               minimize_size=True, allow_mixed=True)
print(f"{out}: {len(images)} unique frames from {len(frames)}", file=sys.stderr)
