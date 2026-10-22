/* Harness-only instrumentation. Production scripts run unchanged below. */
const profileJob = __JOB__;

const profileRows = [], profileFrames = [];

let current, decodedResolve;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const profileState = {
  page: 0,
  zoom: 'width',
  format: profileJob.codec
};

const originalDecode = HTMLImageElement.prototype.decode;

HTMLImageElement.prototype.decode = async function() {
  const start = performance.now();
  await originalDecode.call(this);
  const frame = profileFrames.at(-1);
  if (frame) frame.decodeMs = performance.now() - start;
};

window.acquireVsCodeApi = () => ({
  getState: () => profileState,
  setState: () => {},
  postMessage: m => {
    if (m.type === 'ready') current = {
      name: 'initial',
      start: performance.now(),
      page: 0
    };
    fetch('/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(m)
    });
    if (m.type === 'decoded') {
      const trace = document.getElementById('manual-frames');
      if (trace) trace.textContent = 'Received: ' + profileFrames.map(f => (f.mime === 'image/svg+xml' ? 'SVG' : 'PNG') + (f.rasterPatch ? ' patch ' + f.bytes + 'B' : '') + (f.type === 'image' ? '' : '(' + f.type + ')')).join(' → ');
      const entry = profileFrames.find(f => f.request === m.id);
      if (entry) entry.inlineSvg = !!m.svg;
      const frame = profileFrames.find(f => f.request === m.id);
      if (frame) {
        frame.dispatchToDecoded = performance.now() - frame.dispatched;
        frame.decodedAt = performance.now();
      }
      painted().then(() => {
        if (frame) frame.dispatchToPaintOpportunity = performance.now() - frame.dispatched;
        if (current) {
          profileRows.push({
            ...current,
            ms: performance.now() - current.start,
            frame
          });
          current = undefined;
        }
        const finish = decodedResolve;
        decodedResolve = undefined;
        finish?.();
      });
    }
  }
});

const events = new EventSource('/events');

events.onmessage = async event => {
  const data = JSON.parse(event.data);
  if (profileJob.cacheDisabled) data.contentId = undefined;
  if (data.type === 'image' || data.frame) {
    if (profileJob.codec !== 'auto' && data.type === 'image' && data.header.mime !== (profileJob.codec === 'svg' ? 'image/svg+xml' : 'image/png')) {
      document.getElementById('status').textContent = 'PROFILE ERROR: unexpected codec ' + data.header.mime;
      throw new Error('Unexpected codec');
    }
    let transferMs = 0;
    if (data.frame) {
      const start = performance.now(), response = await fetch(data.frame);
      data.bytes = await response.arrayBuffer(); transferMs = performance.now() - start;
    }
    profileFrames.push({
      type: data.type, request: data.header.requestId, mime: data.header.mime,
      bytes: data.bytes?.byteLength || 0, cacheReference: !data.frame && !data.svgPatch && !data.rasterPatch,
      rasterPatch: data.rasterPatch, svgPatch: !!data.svgPatch, patchBytes: data.svgPatch ? new TextEncoder().encode(JSON.stringify(data.svgPatch)).length : 0,
      width: data.header.width, height: data.header.height,
      processingMs: data.profileProcessingMs,
      transferMs, dispatched: performance.now()
    });
  }
  window.dispatchEvent(new MessageEvent('message', {
    data
  }));
};

(async () => {
  if (profileJob.manual) {
    const controls = document.createElement('aside');
    const trace = document.createElement('span'); trace.id = 'manual-frames'; trace.textContent = 'Waiting for frames';
    for (const [label, mode] of [['Type letter on page 1', 'letter'], ['Backspace on page 1', 'backspace']]) {
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = () => fetch('/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, page: 0, letter: 'c' }) });
      controls.appendChild(button);
    }
    controls.appendChild(trace); document.body.insertBefore(controls, document.getElementById('viewport'));
    return;
  }
  const nextFrame = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser frame timeout')), 6e4);
    decodedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await nextFrame();
  await wait(150);
  const operation = async (name, page, action) => {
    const finished = nextFrame();
    current = {
      name,
      page,
      start: performance.now()
    };
    await action();
    await finished;
    await wait(150);
  };
  const navigate = page => {
    const input = document.getElementById('page');
    input.value = String(page + 1);
    input.dispatchEvent(new Event('change'));
  };
  await operation('page-next-new', 1, () => navigate(1));
  await operation('page-previous-cached', 0, () => navigate(0));
  await operation('page-next-cached', 1, () => navigate(1));
  await operation('page-last-new', profileJob.pages - 1, () => navigate(profileJob.pages - 1));
  await operation('page-first-compiled', 0, () => navigate(0));
  for (const letter of 'abcde') await operation('edit-letter', 0, () => fetch('/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 0, mode: 'letter', letter })
  }));
  for (let i = 0; i < 2; i++) await operation('edit-backspace', 0, () => fetch('/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 0, mode: 'backspace' })
  }));
  for (let i = 0; i < 3; i++) await operation('edit-text', 0, () => fetch('/edit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      page: 0
    })
  }));
  if (profileJob.fixture.startsWith('tikz')) for (let i = 0; i < 3; i++) await operation('edit-coordinate', 0, () => fetch('/edit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      page: 0,
      coordinate: true
    })
  }));
  await operation('edit-font', 0, () => fetch('/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 0, mode: 'font' })
  }));
  const image = document.getElementById('image'), raster = [];
  const inline = document.getElementById('vector');
  for (let i = 0; i < (inline.hidden ? 7 : 0); i++) {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const rect = image.getBoundingClientRect();
    canvas.width = Math.ceil(rect.width * devicePixelRatio);
    canvas.height = Math.ceil(rect.height * devicePixelRatio);
    const start = performance.now();
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.getImageData(0, 0, canvas.width, canvas.height);
    raster.push(performance.now() - start);
    canvas.width = canvas.height = 0;
    await painted();
  }
  const result = {
    ...profileJob,
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    viewport: [ innerWidth, innerHeight ],
    rows: profileRows,
    frames: profileFrames,
    rasterReadbackMs: raster,
    heap: performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize
    } : null
  };
  await fetch('/result', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(result)
  });
  const select = name => profileRows.filter(row => row.name === name).map(row => row.ms);
  parent.postMessage({
    profileDone: true,
    summary: {
      ...profileJob,
      dpr: devicePixelRatio,
      metrics: {
        initial: select('initial'),
        page: select('page-first-compiled'),
        edit: select('edit-text'),
        coordinate: select('edit-coordinate'),
        typing: select('edit-letter'),
        decode: profileFrames.filter(frame => frame.decodeMs !== undefined).map(frame => frame.decodeMs),
        cache: select('page-previous-cached').concat(select('page-next-cached'))
      }
    }
  }, location.origin);
})().catch(error => {
  document.getElementById('status').textContent = 'PROFILE ERROR: ' + error.message;
});
