#!/usr/bin/env python3
"""Generate local fixtures and compare compact MuPDF PNG / outlined SVG export.

No downloads. Requires a completed native MuPDF build and local XeLaTeX + TikZ.
On macOS, compilation uses the installed Xcode SDK and Homebrew codec libraries.
"""
import argparse
import gzip
import json
import platform
from pathlib import Path
import random
import shlex
import shutil
import struct
import subprocess
import time
import zlib


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def make_fixtures(output):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    # Deliberately difficult to compress: synthetic raster, not a photo benchmark.
    rng = random.Random(42)
    samples = bytearray()
    for y in range(512):
        samples.append(0)
        for x in range(512):
            samples.extend(((x // 2 + rng.randrange(128)) % 256,
                            (y // 2 + rng.randrange(128)) % 256,
                            ((x + y) // 4 + rng.randrange(128)) % 256))
    (output / "raster.png").write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 512, 512, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(samples)) + chunk(b"IEND", b""))
    preamble = r"""\documentclass[a4paper,10pt]{article}
\usepackage[margin=22mm]{geometry}
\usepackage{amsmath,graphicx,tikz,hyperref}
\pagestyle{empty}
\begin{document}
"""
    text = r"""\section*{Text and mathematics}
\hypertarget{target}{A destination.} \href{https://example.org}{An external link.}
\hyperlink{target}{An internal link.}
""" + (r"""TeXpresso updates a document as its source changes. This paragraph contains
ordinary text, several words repeated to exercise glyph reuse, and mathematics:
\(\int_0^\infty e^{-x^2}\,dx=\sqrt{\pi}/2\), \(\sum_{n=1}^N n=N(N+1)/2\).
\par\smallskip
""" * 16)
    vector = r"""\section*{Dense vector drawing}
\begin{tikzpicture}[x=0.18cm,y=0.18cm]
\foreach \x in {0,...,39} {
  \foreach \y in {0,...,49} {
    \draw[blue!60!black,line width=0.2pt] (\x,\y) circle[radius=0.36];
    \draw[red!70!black,line width=0.15pt] (\x,\y) -- +(0.45,0.55);
  }
}
\end{tikzpicture}
"""
    raster = r"""\section*{Synthetic raster image}
\includegraphics[width=\linewidth]{raster.png}
"""
    for name, body in (("text", text), ("vector", vector), ("raster", raster)):
        (output / f"{name}.tex").write_text(preamble + body + "\n\\end{document}\n")
        run(["xelatex", "-interaction=nonstopmode", "-halt-on-error", f"{name}.tex"], cwd=output)
    # Capture the live XDV specials too; this does not invoke Tectonic.
    run(["xelatex", "-no-pdf", "-interaction=nonstopmode", "-halt-on-error", "text.tex"], cwd=output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mupdf-build", type=Path, required=True,
                        help="MuPDF source tree containing build/vscode/libmupdf.a")
    parser.add_argument("--output", type=Path, required=True, help="new output directory")
    parser.add_argument("--widths", type=int, nargs="+", default=[1600, 2400])
    parser.add_argument("--repeats", type=int, default=7)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    mupdf = args.mupdf_build.resolve()
    flags = shlex.split(run(["pkg-config", "--cflags", "--libs", "freetype2", "libjpeg",
                             "libopenjp2", "libbrotlidec", "libbrotlienc"]))
    cc = ["xcrun", "clang"] if platform.system() == "Darwin" else ["cc"]
    extra = ["-L/opt/homebrew/lib"] if platform.system() == "Darwin" else []
    run(cc + ["-O2", "-I" + str(mupdf / "include"), str(Path(__file__).with_suffix(".c")),
              str(mupdf / "build/vscode/libmupdf.a"), str(mupdf / "build/vscode/libmupdf-third.a")]
        + flags + extra + ["-ljbig2dec", "-lz", "-lm", "-o", str(output / "preview")])
    if not shutil.which("xelatex"):
        raise SystemExit("Local xelatex is required; nothing will be downloaded")
    make_fixtures(output)
    results = []
    for name in ("text", "vector", "raster"):
        for width in args.widths:
            prefix = output / f"{name}-{width}"
            result = json.loads(run([str(output / "preview"), str(output / f"{name}.pdf"),
                                     str(width), str(args.repeats), str(prefix)]))
            svg = prefix.with_suffix(".svg").read_bytes()
            result.update(fixture=name)
            for level in (1, 6):
                start = time.perf_counter()
                for _ in range(args.repeats):
                    compressed = gzip.compress(svg, compresslevel=level, mtime=0)
                result[f"svg_gzip{level}_bytes"] = len(compressed)
                result[f"svg_gzip{level}_ms"] = round(
                    1000 * (time.perf_counter() - start) / args.repeats, 3)
            results.append(result)
            print(json.dumps(result), flush=True)
    (output / "results.json").write_text(json.dumps({
        "host": platform.platform(), "results": results,
        "method": "One untimed warm-up; arithmetic mean of repeated exports from one display list."
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
