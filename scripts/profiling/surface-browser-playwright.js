// Evaluate this trusted local file as a function and pass a Playwright Page.
// The benchmark server must already be running. It creates and closes its own
// browser contexts, preserving the caller's page. Pass {scales:[2]} for legacy.
async (page, { baseUrl = 'http://127.0.0.1:9383', scales = [1.25, 1.5, 2] } = {}) => {
  const browser = page.context().browser(), results = [];
  for (const dpr of scales) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: dpr });
    const test = await context.newPage(), session = await browser.newBrowserCDPSession();
    try {
      for (const index of dpr === 2 ? [0, 1, 2] : [0]) {
        const before = await (await test.request.get(baseUrl + '/status')).json();
        await test.goto(baseUrl + '/preview?index=' + index);
        const deadline = Date.now() + 60000;
        let status;
        do {
          const info = await session.send('SystemInfo.getProcessInfo');
          const response = await test.request.post(baseUrl + '/browser-processes', { data: info.processInfo });
          if (!response.ok()) throw Error('Browser memory registration: HTTP ' + response.status());
          status = await (await test.request.get(baseUrl + '/status')).json();
          if (status.completed > before.completed) break;
          await new Promise(resolve => setTimeout(resolve, 400));
        } while (Date.now() < deadline);
        const error = await test.locator('#status').textContent();
        if (status.completed <= before.completed || error) throw Error('Browser workload failed: ' + (error || 'timeout'));
        results.push({ dpr, index, completed: status.completed });
      }
    } finally {
      await session.detach();
      await context.close();
    }
  }
  return results;
};
