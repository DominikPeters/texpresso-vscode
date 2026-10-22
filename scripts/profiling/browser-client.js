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
    if (data.type === 'image' && data.header.mime !== (profileJob.codec === 'svg' ? 'image/svg+xml' : 'image/png')) {
      document.getElementById('status').textContent = 'PROFILE ERROR: unexpected codec ' + data.header.mime;
      throw new Error('Unexpected codec');
    }
    let transferMs = 0;
    if (data.frame) {
      const start = performance.now(), response = await fetch(data.frame);
      data.bytes = await response.arrayBuffer(); transferMs = performance.now() - start;
    }
    profileFrames.push({
      request: data.header.requestId, mime: data.header.mime,
      bytes: data.bytes?.byteLength || 0, cacheReference: !data.frame,
      width: data.header.width, height: data.header.height,
      transferMs, dispatched: performance.now()
    });
  }
  window.dispatchEvent(new MessageEvent('message', {
    data
  }));
};

(async () => {
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
  const image = document.getElementById('image'), raster = [];
  for (let i = 0; i < 7; i++) {
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
        decode: profileFrames.filter(frame => frame.decodeMs !== undefined).map(frame => frame.decodeMs),
        cache: select('page-previous-cached').concat(select('page-next-cached'))
      }
    }
  }, location.origin);
})().catch(error => {
  document.getElementById('status').textContent = 'PROFILE ERROR: ' + error.message;
});
