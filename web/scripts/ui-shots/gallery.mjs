// --gallery: the phone list of every style and mode in one picture.

/** The captures side by side, each with its name: one picture to send. */
export async function writeGallery(browser, shots, file) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const cells = shots
    .map(
      ({ label, picture }) =>
        `<figure><img src="data:image/png;base64,${picture.toString('base64')}"><figcaption>${label}</figcaption></figure>`
    )
    .join('');
  await page.setContent(`<!doctype html><style>
    body{margin:0;padding:24px;background:#222;color:#eee;font:14px system-ui;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
    figure{margin:0}img{width:100%;display:block;border:1px solid #444}figcaption{padding:6px 0;text-align:center}
  </style>${cells}`);
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  console.log(`ui-shots: ${file}`);
}
