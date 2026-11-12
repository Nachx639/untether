#!/usr/bin/env node
// Portable before/after evidence. Embeds a pair for every captured view and scroll position;
// original PNGs remain in the input directories. No server, external fonts or network needed.
// node web/scripts/ui-shots-report.mjs <before> <after> <report-directory>
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { pngPixels } from './png-pixels.mjs';

const [beforeArg, afterArg, reportArg, look = 'clay'] = process.argv.slice(2);
const [beforeDir, afterDir, reportDir] = [beforeArg, afterArg, reportArg].map(value => value && path.resolve(value));
if (!/^[a-z0-9-]+$/.test(look)) throw new Error('Invalid look id');
const title = look === 'clay' ? 'Clay' : look === 'cyber-hacker' ? 'Cyber / Hacker' : look;
const checklist = path.relative(reportDir || '.', path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../docs/ui-tokens.md'));
const beforeLabel = look === 'clay' ? 'Clay v2' : 'versión inicial';
if (!reportDir) throw new Error('usage: ui-shots-report.mjs <before> <after> <report-directory> [look-id]');
const shots = dir => fs.readdirSync(dir).filter(name => name.endsWith('.png') && !/-(FAILED|UNSETTLED-[AB])\.png$/.test(name)).sort();
const before = shots(beforeDir);
const after = shots(afterDir);
const missing = [...before.filter(name => !after.includes(name)), ...after.filter(name => !before.includes(name))];
if (missing.length) throw new Error(`Unpaired evidence: ${missing.join(', ')}`);
if (!after.length) throw new Error('No screenshots');
fs.mkdirSync(reportDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
const entries = [];
const homeShot = before.find(name => name === `webkit-mobile-${look}-light.png` || name === `webkit-mobile-${look}-dark.png`);
if (before.includes(homeShot)) {
  fs.copyFileSync(path.join(beforeDir, homeShot), path.join(reportDir, 'header-before.png'));
  fs.copyFileSync(path.join(afterDir, homeShot), path.join(reportDir, 'header-after.png'));
}
try {
  for (const name of after) {
    const files = [beforeDir, afterDir].map(dir => fs.readFileSync(path.join(dir, name)));
    const previous = pngPixels(files[0]);
    const next = pngPixels(files[1]);
    // A longer description or density scale can grow a locator capture. Preserve each
    // image’s actual proportions, with blank space below the shorter one, never stretch it.
    const width = Math.max(previous.width, next.width);
    const height = Math.max(previous.height, next.height);
    const data = await page.evaluate(async ({ pictures, width, height, beforeLabel }) => {
      // Retain phone detail at 1.5× CSS resolution; desktop at CSS resolution.
      const scale = width <= 900 ? .75 : .5;
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w * 2;
      canvas.height = h + 36;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#222';
      ctx.font = '18px system-ui';
      ctx.fillText(`ANTES · ${beforeLabel}`, 12, 25);
      ctx.fillText('DESPUÉS · cobertura completa', w + 12, 25);
      for (let index = 0; index < pictures.length; index++) {
        const image = new Image();
        image.src = pictures[index];
        await image.decode();
        ctx.drawImage(image, index * w, 36, Math.round(image.naturalWidth * scale), Math.round(image.naturalHeight * scale));
      }
      return canvas.toDataURL('image/webp', .86).split(',')[1];
    }, { pictures: files.map(file => `data:image/png;base64,${file.toString('base64')}`), width, height, beforeLabel });
    const image = name.replace(/\.png$/, '.webp');
    entries.push({ name, image, width, height, beforeSize: [previous.width, previous.height], afterSize: [next.width, next.height], data: `data:image/webp;base64,${data}` });
  }
} finally {
  await browser.close();
}
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
fs.writeFileSync(path.join(reportDir, 'index.html'), `<!doctype html>
<html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title} · inventario antes / después</title>
<style>
body{max-width:1500px;margin:auto;padding:24px;background:#f7f3ed;color:#251b14;font:16px/1.5 system-ui}
header{max-width:1000px}input{font:inherit;padding:12px;width:min(90%,600px)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,560px),1fr));gap:24px;margin-top:24px}
figure{margin:0;padding:12px;background:white;border:1px solid #b9afa4;border-radius:12px}figure[hidden]{display:none}
dialog{max-width:95vw;max-height:95vh;padding:16px;overflow:auto}dialog img{width:auto;max-width:none}dialog button,dialog a{font:inherit;margin-right:16px}img{display:block;width:100%;height:auto}figcaption{overflow-wrap:anywhere;padding:8px 0}a{color:#75401e}
</style><header><h1>${title} · inventario antes / después</h1>
<p>${entries.length} pares de capturas del gemelo, WebKit, móvil 390×844 y escritorio 1440×900.
Incluyen desplazamientos y capturas individuales de cada tarjeta de Apariencia. Las imágenes están integradas en este HTML. Pulsa para ampliar o descargar cada comparación.
La izquierda es ${beforeLabel}; la derecha, la cobertura de esta tarea.</p>
<p>Referencia: ${look}-maqueta-lista.png y ${look}-maqueta-tarea.png.
El catálogo «pieces» muestra controles compartidos sin un ejemplo activo; las demás capturas usan componentes reales.
El simulador WebKit no reproduce el desenfoque nativo del sistema iOS.</p>
${before.includes(homeShot) ? '<p>Cabecera móvil en PNG original, sin reducir ni comprimir con pérdidas: <a href="header-before.png">antes</a> · <a href="header-after.png">después</a>.</p>' : ''}
<p><a href="${checklist}#style-coverage-checklist-clay-audit-2026-11-09">Checklist por pieza y excepciones justificadas</a> ·
<a href="verification.json">Verificación y medidas</a></p>
<label>Filtrar por pantalla o tamaño <input id="filter" type="search" placeholder="settings, mobile, session, answer…"></label>
<p id="count" aria-live="polite">${entries.length} comparativas</p></header><main>
${entries.map(entry => `<figure data-name="${escape(entry.name)}"><figcaption>${escape(entry.name.replace('webkit-', '').replace(`-${look}-light.png`, '').replace(`-${look}-dark.png`, ''))}</figcaption><a href="#zoom" download="${entry.image}" class="open-pair"><img loading="lazy" src="${entry.data}" alt="Antes y después de ${escape(entry.name)}"></a></figure>`).join('\n')}
</main><dialog id="zoom" aria-label="Comparativa ampliada"><button type="button" id="close-zoom">Cerrar</button><a id="download-pair">Descargar WebP</a><img alt="Comparativa ampliada antes y después"></dialog><script>const zoom=document.querySelector('#zoom');document.querySelector('#close-zoom').addEventListener('click',()=>zoom.close());document.querySelector('main').addEventListener('click',event=>{const link=event.target.closest('.open-pair');if(!link)return;event.preventDefault();zoom.querySelector('img').src=link.querySelector('img').src;const download=document.querySelector('#download-pair');download.href=zoom.querySelector('img').src;download.download=link.download;zoom.showModal()});document.querySelector('#filter').addEventListener('input',event=>{let count=0;for(const figure of document.querySelectorAll('figure')){figure.hidden=!figure.dataset.name.includes(event.target.value.trim().toLowerCase());if(!figure.hidden)count++}document.querySelector('#count').textContent=count+' comparativas'})</script></html>`);
fs.writeFileSync(path.join(reportDir, 'manifest.json'), JSON.stringify({ engine: 'WebKit', storage: 'inline-webp-in-index.html', entries: entries.map(({ data, ...entry }) => entry) }, null, 2));
// Remove only this report's superseded external pairs after the portable HTML is complete.
for (const entry of entries) {
  const previous = path.join(reportDir, entry.image);
  if (fs.existsSync(previous)) fs.unlinkSync(previous);
}
console.log(`ui-shots-report: ${entries.length} before/after pairs → ${reportDir}/index.html`);
