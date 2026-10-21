// Optional local Chromium experiment. Uses an already installed Playwright and
// Chrome; no browser installation or remote content. Not a VS Code IPC benchmark.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const directory = path.resolve(process.argv[2]);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 1152 }, deviceScaleFactor: 2 });
    await page.route('**/*', route => route.abort());
    await page.setContent('<style>body{margin:0;background:#ddd}img{display:block;width:800px;background:white}</style><img>');
    const results = [];
    for (const fixture of ['text', 'vector', 'raster']) {
      for (const format of ['png', 'svg']) {
        const data = await fs.readFile(path.join(directory, `${fixture}-1600.${format}`));
        const result = await page.evaluate(async ({ base64, format }) => {
          // Materialize bytes before timing, so base64 is only test-harness input.
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          const image = document.querySelector('img');
          const decode = [], frame = [], raster = [];
          const canvas = document.createElement('canvas');
          canvas.width = 1600; canvas.height = 2263;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          for (let i = -1; i < 7; i++) {
            const url = URL.createObjectURL(new Blob([bytes], {
              type: format === 'png' ? 'image/png' : 'image/svg+xml'
            }));
            const start = performance.now();
            image.src = url;
            await image.decode();
            const decoded = performance.now();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const displayed = performance.now();
            const beforeRaster = performance.now();
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            // Force completion of raster work; includes canvas readback overhead.
            context.getImageData(0, 0, canvas.width, canvas.height);
            const afterRaster = performance.now();
            if (i >= 0) {
              decode.push(decoded - start); frame.push(displayed - start);
              raster.push(afterRaster - beforeRaster);
            }
            URL.revokeObjectURL(url);
          }
          const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
          return { decode_ms: mean(decode), decode_two_frames_ms: mean(frame),
            canvas_draw_readback_ms: mean(raster), naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight };
        }, { base64: data.toString('base64'), format });
        await page.screenshot({ path: path.join(directory, `${fixture}-${format}-browser.png`) });
        results.push({ fixture, format, ...result });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
    await fs.writeFile(path.join(directory, 'browser-results.json'), JSON.stringify({
      browser: browser.version(), viewport_css: [820, 1152], dpr: 2,
      note: 'Warm local Blob decode; frame timing includes two rAF waits. Canvas includes readback. No VS Code IPC.',
      results
    }, null, 2) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
