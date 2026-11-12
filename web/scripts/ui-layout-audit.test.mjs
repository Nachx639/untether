import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { inspectUILayout } from './ui-layout-audit.mjs';

// The app's own title pieces (styles/list/task-row.css), not a copy: the test fails if they go.
const listCss = fs.readFileSync(new URL('../src/client/styles/list/task-row.css', import.meta.url), 'utf8');
const pieces = listCss.slice(listCss.indexOf('.ut-title-lines {'), listCss.indexOf('.tsk-prefix {'));
assert.match(pieces, /\.ut-title-lines\[data-cut\] > \.ut-mid-end \{/);

// The app's own piece for a bar with another under it (styles/material.css), not a copy.
const materialCss = fs.readFileSync(new URL('../src/client/styles/material.css', import.meta.url), 'utf8');
const stackPiece = materialCss.match(/:root \.ut-surface--bar\.ut-surface--bar-over,[^{]*\{[^}]*\}/)?.[0];
assert.ok(stackPiece, 'styles/material.css keeps the piece .ut-surface--bar-over');

// The app's own session header (styles/session.css), not a copy: its title and its two lines.
const sessionCss = fs.readFileSync(new URL('../src/client/styles/session.css', import.meta.url), 'utf8');
const headerPiece = sessionCss.slice(sessionCss.indexOf('  .ut-session-header {'), sessionCss.indexOf('  .ut-session-header-divider {'));
assert.match(headerPiece, /\.ut-session-header-line2 > git-status-badge > \.ut-git-branch \{/);

// The app's own measure of a two-line title (utils/card-line.ts titleLinesCut), not a copy.
const { build } = await import('esbuild');
const cardLine = (await build({
  entryPoints: [fileURLToPath(new URL('../src/client/utils/card-line.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'cardLine', platform: 'browser', target: 'es2022', logLevel: 'silent',
})).outputFiles[0].text;
// card-line.ts fitTitleLines: `data-cut` while two lines still cut the title.
const fitTitles = async page => {
  await page.addScriptTag({ content: cardLine });
  await page.locator('.ut-title-lines').evaluateAll(list => list.forEach(el => { el.removeAttribute('data-cut'); el.toggleAttribute('data-cut', cardLine.titleLinesCut(el)); }));
};

// The two parts utils/card-line.ts midCutTitle gives a title: the end word by word, each with
// the space before it, numbered from the last one.
const midParts = (name, at) => {
  const words = name.slice(at).match(/\s*\S+/gu);
  const leave = at >= Math.max(...words.map(word => word.length)) + 6;
  return `<span class="ut-mid-start" data-keep="${at < 8 ? 'short' : 'long'}">${name.slice(0, at)}</span><span class="ut-mid-end"${leave ? ' data-leave' : ''}>${words.map((word, index) => `<span class="ut-mid-word" style="order:${words.length - 1 - index}">${word}</span>`).join('')}</span>`;
};
// The pieces as task 29574450 merged them (2026-11-10): the end one text, held to 62% of the
// line and clipped from its left. Kept here so the audit is proven against the real regression.
const piecesBefore = '.ut-mid{display:flex;min-width:0;white-space:pre}.ut-mid>*{flex:none}.ut-mid>.ut-mid-start{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.ut-mid>.ut-mid-end{display:flex;justify-content:flex-end;max-width:62%;overflow:hidden}';

for (const [name, engine] of Object.entries({ webkit, chromium })) {
  test(`${name}: layout invariants for any look`, async t => {
    const browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const inspect = async html => {
      await page.setContent(`<meta name="viewport" content="width=device-width"><style>body{margin:0}button{border:0;box-sizing:border-box}</style>${html}`);
      return page.evaluate(inspectUILayout);
    };
    try {
      // 2026-11-11, the desktop home in Clay: header and list toolbar, each a bar with its own
      // bottom corners, edge and shadow, as the styles painted every .ut-surface--bar.
      await t.test('two stacked bars are one surface: the one on top has no corners, edge or shadow of its own', async () => {
        const look = '.ut-surface--bar{height:52px;background:#fa8;border-bottom:1px solid #c63;border-radius:0 0 24px 20px;box-shadow:inset 0 -2px 0 #9414,0 4px 0 #dcb}';
        const stack = css => `<style>:root{--ut-bar-seam:#c63}${look}${css}</style><header class="ut-surface--bar ut-home-header"></header><div class="ut-surface--bar"></div><main style="height:300px"></main>`;
        const kinds = result => result.failures.map(f => f.kind).filter(kind => kind.startsWith('stacked-bar')).sort();
        const bad = await inspect(stack(''));
        assert.equal(bad.checks.stackedBars, 1);
        assert.deepEqual(kinds(bad), ['stacked-bar-own-corners', 'stacked-bar-own-edge']);
        // The piece, on the bar on top: the joint is a straight fillet, the last bar keeps its own.
        await page.locator('header').evaluate(el => el.classList.add('ut-surface--bar-over'));
        await page.addStyleTag({ content: stackPiece });
        const good = await page.evaluate(inspectUILayout);
        assert.equal(good.checks.stackedBars, 1);
        assert.deepEqual(good.failures, []);
        assert.equal(await page.locator('div.ut-surface--bar').evaluate(el => getComputedStyle(el).borderBottomLeftRadius), '20px');
        assert.equal(await page.locator('header').evaluate(el => getComputedStyle(el).borderBottomColor), 'rgb(204, 102, 51)');
        // The page showing between the two, or the lower one rounded on top, fails as well.
        assert.deepEqual(kinds(await inspect(stack('.ut-surface--bar{border-radius:0;box-shadow:none}div.ut-surface--bar{margin-top:3px}'))), ['stacked-bar-gap', 'stacked-bar-own-edge']);
        assert.deepEqual(kinds(await inspect(stack('.ut-surface--bar{border-radius:0;box-shadow:none}div.ut-surface--bar{border-radius:8px 8px 0 0}'))), ['stacked-bar-own-corners']);
        assert.deepEqual(kinds(await inspect(stack('.ut-surface--bar{border-radius:0;box-shadow:none}div.ut-surface--bar{margin-left:12px}'))), ['stacked-bar-ends-apart']);
        // The home: its header takes the piece by itself while a toolbar follows it, whatever
        // box wraps the list; with no toolbar under it, it keeps its own corners and edge.
        const home = (list, css = '') => `<style>:root{--ut-bar-seam:#c63}${look}${stackPiece}${css}</style><app-header style="display:block"><header class="ut-surface--bar ut-home-header"></header></app-header>${list}<main style="height:300px"></main>`;
        for (const list of ['<div class="ut-list-surface"><session-list><div class="ut-list-toolbar ut-surface--bar"></div></session-list></div>', '<section><div><div class="ut-list-toolbar ut-surface--bar"></div></div></section>']) {
          const joined = await inspect(home(list));
          assert.equal(joined.checks.stackedBars, 1);
          assert.deepEqual(joined.failures, []);
        }
        await inspect(home('<div class="ut-list-surface"></div>'));
        assert.equal(await page.locator('header').evaluate(el => getComputedStyle(el).borderBottomLeftRadius), '20px');
        assert.notEqual(await page.locator('header').evaluate(el => getComputedStyle(el).boxShadow), 'none');
        // A layer of the bar on top that draws the edge the bar may not.
        assert.deepEqual(kinds(await inspect(home('<div class="ut-list-toolbar ut-surface--bar"></div>', '.ut-home-header{position:relative}.ut-home-header::after{content:"";position:absolute;inset:0;border-radius:0 0 12px 12px;box-shadow:0 2px 0 #9414}'))), ['stacked-bar-own-corners', 'stacked-bar-own-edge']);
        // A bar alone, or beside another, is not a pair.
        const alone = await inspect(`<style>${look}</style><div style="display:flex"><header class="ut-surface--bar" style="flex:1"></header><div class="ut-surface--bar" style="flex:1"></div></div>`);
        assert.equal(alone.checks.stackedBars, 0);
        assert.deepEqual(alone.failures, []);
      });
      await t.test('a raised icon must fit its bar, including the relief', async () => {
        const bad = await inspect('<header role="toolbar" style="height:52px"><button style="height:44px;margin:4px;box-shadow:0 7px 4px #555">More</button></header>');
        assert.ok(bad.failures.some(f => f.kind === 'control-outside-container'));
        await page.locator('button').evaluate(el => el.style.height = '32px');
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
      });
      await t.test('an optical-edge control may hang its padding out, never its glyph or the window', async () => {
        const row = (attr, style = '') => `<div class="ut-phone-section" style="width:200px;height:44px;margin:0 20px"><button ${attr} style="width:44px;height:44px;padding:0;margin-left:168px;${style}"><svg width="18" height="18" style="margin:13px"></svg></button></div>`;
        // Padding 12 px past the edge, glyph inside: only a marked control is excused.
        assert.ok((await inspect(row(''))).failures.some(f => f.kind === 'control-outside-container'));
        assert.deepEqual((await inspect(row('data-ut-optical-edge'))).failures, []);
        // The glyph itself past the edge is still a failure, mark or not.
        assert.ok((await inspect(row('data-ut-optical-edge', 'margin-left:196px'))).failures.some(f => f.kind === 'control-outside-container'));
        // And the box may not leave the window (past the left edge, which no engine scrolls to).
        const left = await inspect(`<div class="ut-phone-section" style="width:200px;height:44px"><button data-ut-optical-edge style="width:44px;height:44px;padding:0;margin-left:-12px"><svg width="18" height="18" style="margin:13px"></svg></button></div>`);
        assert.ok(left.failures.some(f => f.kind === 'viewport-clipping'));
        assert.ok(!left.failures.some(f => f.kind === 'control-outside-container'));
      });
      await t.test('fixed controls cannot leave the window even inside a scroller', async () => {
        const bad = await inspect('<div style="height:200px;overflow:auto"><div style="height:1200px"><nav style="position:fixed;bottom:-10px"><button style="height:44px">New</button></nav></div></div>');
        assert.ok(bad.failures.some(f => f.kind === 'viewport-clipping'));
      });
      await t.test('scrolling content is allowed to cross its viewport; hidden clipping is not', async () => {
        const good = await inspect('<div style="height:100px;overflow:auto"><div style="height:80px"></div><button style="height:44px">Scroll to me</button><div style="height:1000px"></div></div>');
        assert.deepEqual(good.failures, []);
        const bad = await inspect('<div style="width:100px;overflow:hidden"><button style="width:140px;height:44px">Clipped</button></div>');
        assert.ok(bad.failures.some(f => f.kind === 'ancestor-clipping'));
      });
      await t.test('scrollable breadcrumbs may cross their bar, fixed siblings may not', async () => {
        await inspect('<header class="ut-surface--bar" style="width:390px;height:60px"><div style="overflow:auto;width:200px"><div style="display:flex;width:800px"><button style="flex:none;width:100px;height:44px">First</button><button style="flex:none;width:100px;height:44px">Second</button></div></div></header>');
        await page.locator('header > div').evaluate(el => el.scrollLeft = 50);
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
        await page.locator('header').evaluate(el => el.insertAdjacentHTML('beforeend', '<button style="position:fixed;top:50px;height:44px">Outside</button>'));
        assert.ok((await page.evaluate(inspectUILayout)).failures.some(f => f.kind === 'control-outside-container'));
      });
      await t.test('modal top layer escapes even a transformed clipping ancestor', async () => {
        await inspect('<div style="transform:translateX(250px);width:100px;height:200px;overflow:hidden"><dialog style="width:300px;margin:100px auto"><button style="height:44px;width:100px">Dialog action</button></dialog></div>');
        await page.locator('dialog').evaluate(el => el.showModal());
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
        assert.equal(await page.locator('button').evaluate(el => {
          const r = el.getBoundingClientRect();
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
        }), true);
        await page.locator('dialog').evaluate(el => { el.close(); el.show(); });
        assert.ok((await page.evaluate(inspectUILayout)).failures.some(f => f.kind === 'ancestor-clipping'));
      });
      await t.test('a menu owns its controls even when anchored inside a toolbar', async () => {
        const good = await inspect('<header role="toolbar" style="height:44px;position:relative"><div class="ut-menu" style="position:absolute;top:48px;width:150px;height:100px"><button style="width:140px;height:44px">Menu action</button></div></header>');
        assert.deepEqual(good.failures, []);
        await page.locator('button').evaluate(el => el.style.width = '200px');
        assert.ok((await page.evaluate(inspectUILayout)).failures.some(f => f.kind === 'control-outside-container'));
      });
      await t.test('an outer clip still allows the inner scroller to reveal its controls', async () => {
        const good = await inspect('<div style="height:100px;overflow:hidden"><div style="height:100px;overflow:auto"><div style="height:80px"></div><button style="height:44px">Scroll to me</button><div style="height:1000px"></div></div></div>');
        assert.deepEqual(good.failures, []);
        await page.locator('div > div').first().evaluate(el => el.style.overflow = 'hidden');
        assert.ok((await page.evaluate(inspectUILayout)).failures.some(f => f.kind === 'ancestor-clipping'));
      });
      await t.test('primary actions and selected tabs need distinct color', async () => {
        const bad = await inspect('<style>:root{--ut-tab-selected-bg:gold}button{background:beige;color:black}</style><nav><button class="ut-surface--primary">New</button><button role="tab" aria-selected="true">Sessions</button><button role="tab">Agents</button></nav>');
        assert.ok(bad.failures.some(f => f.kind === 'primary-indistinguishable'));
        assert.ok(bad.failures.some(f => f.kind === 'selected-indistinguishable'));
        await page.addStyleTag({ content: '.ut-surface--primary{background:coral}[aria-selected=true]{background:gold}' });
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
      });
      await t.test('a labelled button never takes an icon\'s fixed width', async () => {
        const row = (orch, label = '') => `<style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}</style><div style="display:flex;justify-content:flex-end"><span style="display:inline-flex;align-items:center"><button id="orch" style="position:relative;display:inline-flex;align-items:center;white-space:nowrap;height:32px;font:600 15px sans-serif;${orch}"><svg width="16" height="16"></svg><span style="${label}" class="label">Orquestador</span></button><button style="height:32px;font:600 15px sans-serif;white-space:nowrap">+ Tarea</button></span></div>`;
        const bad = await inspect(row('width:32px;flex-shrink:0'));
        assert.ok(bad.failures.some(f => f.kind === 'text-outside-control' && f.element.id === 'orch'));
        assert.ok(bad.failures.some(f => f.kind === 'text-over-sibling' && f.sibling.text === '+ Tarea'));
        assert.deepEqual((await inspect(row('min-width:32px'))).failures, []);
        // Truncated inside its face, or left to the screen reader: nothing painted outside.
        assert.deepEqual((await inspect(row('width:60px', 'overflow:hidden;text-overflow:ellipsis;min-width:0'))).failures, []);
        await inspect(row('width:32px;justify-content:center'));
        await page.locator('.label').evaluate(el => el.classList.add('sr'));
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
      });
      await t.test('a project header gives its room to the name before any other word', async () => {
        // The real pieces' classes, with the widths of the 2026-11-10 capture: the name cut to
        // three letters while "Orquestador" and "+ Tarea" kept their words.
        const head = (name, tools, more = '') => `<style>.prj-head{display:flex;align-items:center;gap:4px;width:300px;height:44px;font:600 12px sans-serif}.prj-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.prj-tools{display:inline-flex;flex:none;margin-left:auto}button{height:44px;white-space:nowrap;font:600 15px sans-serif}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}${more}</style><div class="prj-head"><h3 style="display:flex;min-width:0;margin:0;font:inherit"><button style="min-width:0;display:inline-flex;font:inherit"><span class="prj-name">${name}</span></button></h3><span class="prj-tools">${tools}</span></div>`;
        const words = '<button><svg width="16" height="16"></svg><span class="label">Orquestador</span></button><button><svg width="16" height="16"></svg><span class="label">Tarea</span></button>';
        const bad = await inspect(head('IA-SOBERANA-ESPANA-Y-PORTUGAL', words));
        const cut = bad.failures.filter(f => f.kind === 'project-name-cut-beside-labels');
        assert.equal(cut.length, 1);
        assert.deepEqual(cut[0].labels.map(l => l.text), ['Orquestador', 'Tarea']);
        // The same name whole next to the same words: nothing to say.
        assert.deepEqual((await inspect(head('UNTETHER', words))).failures, []);
        // The words gone to the screen reader, the name still cut but telling: allowed.
        await inspect(head('IA-SOBERANA-ESPANA-Y-PORTUGAL-Y-ANDORRA-Y-FRANCIA', words));
        await page.locator('.label').evaluateAll(els => els.forEach(el => el.classList.add('sr')));
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
        // Cut to a stub with nothing left to give way: still a failure.
        const stub = await inspect(head('IA-SOBERANA-ESPANA', '<button style="width:250px"><svg width="16" height="16"></svg></button>'));
        assert.ok(stub.failures.some(f => f.kind === 'project-name-stub'));
        // A branch chip counts as a word too.
        const chip = await inspect(head('IA-SOBERANA-ESPANA-Y-PORTUGAL-Y-ANDORRA', '<span class="prj-branch" style="flex:none">integracion/modelos</span>'));
        assert.ok(chip.failures.some(f => f.kind === 'project-name-cut-beside-labels' && f.labels[0].classes === 'prj-branch'));
      });
      await t.test('a line of the style tells one project from the next', async () => {
        const list = css => `<style>.prj-head{display:flex;align-items:center;height:44px;margin-top:12px}.prj-name{font:600 12px sans-serif;text-transform:uppercase}.psr{height:64px;font:500 15px sans-serif;border-bottom:1px solid silver}${css}</style><div>${['faro', 'huerto', 'lumen'].map(name => `<project-group><section class="prj"><div class="prj-head"><span class="prj-name">${name}</span></div><div class="psr"><span>Una fila</span></div><div class="psr"><span>Otra fila</span></div></section></project-group>`).join('')}</div>`;
        const none = await inspect(list(''));
        assert.equal(none.failures.filter(f => f.kind === 'project-divider-missing').length, 2);
        const line = 'project-group + project-group > .prj::before{content:"";display:block;height:1px;margin-top:10px;background:linear-gradient(90deg,transparent,goldenrod,transparent)}';
        const good = await inspect(list(line));
        assert.deepEqual(good.failures, []);
        assert.equal(good.checks.projectDividers, 2);
        // A transparent line is no line; a band is not a line; a line needs its air.
        assert.equal((await inspect(list(line.replace(/background:[^}]*/, 'background:transparent')))).failures.filter(f => f.kind === 'project-divider-missing').length, 2);
        assert.equal((await inspect(list(line.replace('height:1px', 'height:12px')))).failures.filter(f => f.kind === 'project-divider-heavy').length, 2);
        assert.equal((await inspect(list(`${line}.prj-head{margin-top:0}`.replace('margin-top:10px', 'margin-top:2px')))).failures.filter(f => f.kind === 'project-divider-cramped').length, 2);
        // A header written like a row's title is one more row.
        assert.ok((await inspect(list(`${line}.prj-name{font:500 15px sans-serif;text-transform:none}`))).failures.some(f => f.kind === 'project-header-like-row'));
        // The sidebar's groups, the same.
        const side = css => `<style>.ut-repo-head{height:24px}.ut-section-label{font:600 11px sans-serif;text-transform:uppercase}.ut-side-row{height:44px;font:500 13px sans-serif}${css}</style><div>${['faro', 'huerto'].map(name => `<div class="ut-side-group"><div class="ut-repo-head"><span class="ut-section-label">${name}</span></div><div class="ut-side-row"><span>Una fila</span></div></div>`).join('')}</div>`;
        assert.ok((await inspect(side(''))).failures.some(f => f.kind === 'project-divider-missing'));
        assert.deepEqual((await inspect(side('.ut-side-group + .ut-side-group::before{content:"";display:block;height:1px;margin:8px 0;background:silver}'))).failures, []);
      });
      await t.test('a folded project shows its header and one whole line, never a row', async () => {
        const folded = (inside, expanded = 'false') => `<style>.prj-head{display:flex;height:44px}.ut-fold-summary{width:200px;overflow:hidden;white-space:nowrap;font:12px sans-serif}.psr{height:64px}</style><section class="prj" data-folded="true"><div class="prj-head"><button class="ut-fold-toggle" aria-expanded="${expanded}"><svg width="14" height="14"></svg></button><span class="prj-name">FARO</span></div>${inside}</section>`;
        const line = '<div class="ut-fold-summary"><span class="ut-fold-needs">1 te necesita</span> · 3 sesiones</div>';
        const good = await inspect(folded(line));
        assert.deepEqual(good.failures, []);
        assert.equal(good.checks.foldedProjects, 1);
        assert.ok((await inspect(folded(`${line}<div class="psr">Una fila</div>`))).failures.some(f => f.kind === 'folded-project-shows-rows'));
        assert.ok((await inspect(folded(line, 'true'))).failures.some(f => f.kind === 'folded-project-no-toggle'));
        assert.ok((await inspect(folded(''))).failures.some(f => f.kind === 'folded-project-no-summary'));
        // What waits for the user pushed out of the line by what comes before it.
        const cut = '<div class="ut-fold-summary">12 sesiones · 9 tareas · 4 en cola · 31 más · <span class="ut-fold-needs">1 te necesita</span></div>';
        assert.ok((await inspect(folded(cut))).failures.some(f => f.kind === 'folded-needs-cut'));
        // The sidebar's groups, the same; an open project is not looked at.
        assert.ok((await inspect('<div class="ut-side-group" data-folded="true"><div class="ut-repo-head" style="height:24px"><button class="ut-fold-toggle" aria-expanded="false">faro</button></div></div>')).failures.some(f => f.kind === 'folded-project-no-summary'));
        assert.equal((await inspect('<section class="prj" data-folded="false"><div class="psr" style="height:64px">Una fila</div></section>')).checks.foldedProjects, 0);
      });
      await t.test('an avatar and its mark stay in their row', async () => {
        const row = mark => `<div style="height:300px"></div><div class="tsk" style="display:flex;height:56px;margin:8px 16px"><div class="psr-avatar" style="position:relative;width:40px;height:40px"><img alt="" style="width:112%;height:112%;${mark}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div><span>Hecha</span></div>`;
        assert.deepEqual((await inspect(row(''))).failures, []);
        const bad = await inspect(row('position:absolute;left:-30px;top:-70px'));
        assert.ok(bad.failures.some(f => f.kind === 'avatar-mark-misplaced'));
        const nested = await inspect(row('filter:drop-shadow(0 1px 1px black)').replace('class="psr-avatar" style="', 'class="psr-avatar" style="filter:grayscale(1);'));
        assert.ok(nested.failures.some(f => f.kind === 'avatar-nested-filter'));
        assert.deepEqual((await inspect(row('filter:grayscale(1) drop-shadow(0 1px 1px black)'))).failures, []);
        const loose = await inspect(row('').replace('position:relative', 'position:absolute;top:0'));
        assert.ok(loose.failures.some(f => f.kind === 'avatar-outside-row'));
      });
      await t.test('phone chrome respects the 59/34 safe areas', async () => {
        await inspect('<header class="ut-surface--bar" style="height:52px"><button style="height:32px">More</button></header><nav class="ut-tabbar" style="position:fixed;bottom:0;height:44px"><button style="height:44px">New</button></nav>');
        const bad = await page.evaluate(inspectUILayout, { safeArea: { top: 59, bottom: 34 } });
        assert.equal(bad.failures.filter(f => f.kind === 'safe-area-overlap').length, 2);
        await page.addStyleTag({ content: 'header{padding-top:59px}nav{padding-bottom:34px}' });
        assert.deepEqual((await page.evaluate(inspectUILayout, { safeArea: { top: 59, bottom: 34 } })).failures, []);
      });
      await t.test('rows of one project never read the same while their titles differ', async () => {
        const names = ['del servidor', 'de agentes e infraestructura', 'de web, iPhone y scripts'].map(end => `Revisión 2ª vuelta: arreglos claros ${end}`);
        const oneLine = '.psr-title,.ut-side-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:16px/20px sans-serif}';
        // The two parts utils/card-line.ts midCutTitle gives a title.
        const parts = name => midParts(name, name.length - (name.endsWith('servidor') ? 13 : name.endsWith('scripts') ? 17 : 18));
        const cards = (width, classes = '') => `<style>${oneLine}${pieces}</style><div class="prj" style="width:${width}px">${names.map(name => `<div class="tsk"><span class="psr-title ${classes}">${parts(name)}</span></div>`).join('')}</div>`;
        const twoLines = async width => {
          const before = await inspect(cards(width, 'ut-title-lines'));
          await fitTitles(page);
          return { before, after: await page.evaluate(inspectUILayout) };
        };
        for (const width of [180, 240]) {
          // The phone of 2026-11-10: one line each, «…arreglos claros de…» three times.
          const bad = await inspect(cards(width));
          assert.equal(bad.failures.filter(f => f.kind === 'titles-read-the-same').length, 2, `one line at ${width}px`);
          assert.deepEqual((await twoLines(width)).after.failures, [], `two lines at ${width}px`);
        }
        // Too narrow for two lines to reach the difference (a 320px phone in a large look):
        // the second line goes to the title's end, and the row is still two lines tall.
        for (const width of [110, 130]) {
          const { before, after } = await twoLines(width);
          assert.ok(before.failures.some(f => f.kind === 'titles-read-the-same'), `two plain lines at ${width}px`);
          assert.deepEqual(after.failures, [], `start and end at ${width}px`);
          assert.equal(await page.locator('.psr-title').evaluateAll(list => list.every(el => el.hasAttribute('data-cut') && el.getBoundingClientRect().height === 40)), true, 'two lines');
          // The first line is the start's, as wide as the title: not an empty line over the end.
          assert.equal(await page.locator('.psr-title').evaluateAll(list => list.every(el => { const title = el.getBoundingClientRect(), start = el.querySelector('.ut-mid-start').getBoundingClientRect(), end = el.querySelector('.ut-mid-end').getBoundingClientRect(); return start.width > title.width - 1 && start.height === 20 && end.top >= start.bottom - 0.5; })), true, 'start over end');
        }
        // A row with one line only (the sidebar's): cut in the middle, the end stays.
        const side = (width, mid) => `<style>${oneLine}${pieces}</style><div class="ut-side-group" style="width:${width}px">${names.map(name => `<div data-testid="compact-task-row"><span class="ut-side-name ${mid ? 'ut-mid' : ''}">${mid ? parts(name) : name}</span></div>`).join('')}</div>`;
        for (const width of [150, 200, 240]) {
          assert.equal((await inspect(side(width, false))).failures.filter(f => f.kind === 'titles-read-the-same').length, 2, `end cut at ${width}px`);
          assert.deepEqual((await inspect(side(width, true))).failures, [], `middle cut at ${width}px`);
          assert.equal(await page.locator('.ut-side-name').evaluateAll(list => list.every(el => el.getBoundingClientRect().height === 20)), true, 'still one line');
        }
        // Whole titles and the same title twice are nothing to tell.
        assert.deepEqual((await inspect(cards(900))).failures, []);
        assert.deepEqual((await inspect(`<style>${oneLine}</style><div class="prj" style="width:200px">${[names[0], names[0]].map(name => `<div class="tsk"><span class="psr-title">${name}</span></div>`).join('')}</div>`)).failures, []);
      });
      await t.test('a title that fits on one line stays on one line, whatever the interline', async () => {
        // 2026-11-11, desktop task cards in Comic and Cosmos (WebKit): the glyphs reach below a
        // tight line, the box held 2-4px more than its height, and the title was split in two.
        const names = ['Ejemplos de autenticación con tokens', 'Separar los turnos de comida y cena', 'Migrar la base de datos a la versión 3'];
        const cards = (font, width) => `<style>.psr-title{font:${font}}${pieces}</style><div class="prj" style="width:${width}px">${names.map(name => `<div class="tsk"><span class="psr-title ut-title-lines" dir="auto">${midParts(name, name.lastIndexOf(' ', name.length - 8))}</span></div>`).join('')}</div>`;
        const fonts = ['600 18px/1 -apple-system, sans-serif', '700 18px/1.16 "Comic Sans MS", cursive', '600 17px/1.17 Georgia, serif', '600 24px/1.1 monospace', '600 16px/1.5 sans-serif'];
        let tight = 0;
        for (const font of fonts) {
          await inspect(cards(font, 900));
          const line = await page.locator('.psr-title').first().evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
          tight += await page.locator('.psr-title').evaluateAll(list => list.filter(el => el.scrollHeight > el.clientHeight + 1).length);
          await fitTitles(page);
          assert.deepEqual(await page.locator('.psr-title').evaluateAll(list => list.map(el => [el.hasAttribute('data-cut'), Math.round(el.getBoundingClientRect().height)])), names.map(() => [false, Math.round(line)]), `${font}: one line, not cut`);
          assert.deepEqual((await page.evaluate(inspectUILayout)).failures, [], font);
          // Split all the same (what the 1px margin did): the audit tells it.
          await page.locator('.psr-title').evaluateAll(list => list.forEach(el => el.setAttribute('data-cut', '')));
          const split = await page.evaluate(inspectUILayout);
          assert.equal(split.failures.filter(f => f.kind === 'title-split-with-room').length, names.length, `${font}: split with room ${JSON.stringify(split.failures)}`);
          // Too long for two lines: still cut, the end on the second line, and nothing to tell.
          await inspect(cards(font, 130));
          await fitTitles(page);
          assert.equal(await page.locator('.psr-title').evaluateAll(list => list.every(el => el.hasAttribute('data-cut'))), true, `${font}: cut at 130px`);
          assert.deepEqual((await page.evaluate(inspectUILayout)).failures.filter(f => f.kind === 'title-split-with-room'), [], `${font} at 130px`);
        }
        // The regression itself: WebKit holds more than a line in a one-line title with a tight interline.
        if (name === 'webkit') assert.ok(tight > 0, 'a fixed 1px margin would have split one-line titles here');
      });
      await t.test('a title cut in the middle reads «start… end», never letters eaten or the halves on top of each other', async () => {
        // "Te necesita" on a phone, 2026-11-10: «Tokenh examples», «Split lu… nd dinner shifts».
        const titles = [['Token auth examples', 5], ['Split lunch and dinner shifts', 11], ['Fix broken links in the guide', 16], ['Ejemplos de autenticación con tokens', 25], ['修复指南中所有损坏的链接和过期的示例代码片段', 12], ['إصلاح الروابط المعطلة في الدليل الجديد', 21], ['ut/tarjetas-de-tarea-titulos-largos-que-se', 24]];
        const oneLine = '.ut-needs-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
        const strip = (css, width, font, old) => `<style>${oneLine}${css}.ut-needs-name{font:${font}}</style><ul class="ut-needs" style="width:${width}px;margin:0;padding:0;list-style:none">${titles.map(([title, at]) => `<li style="display:flex"><span style="display:flex;flex:1;flex-direction:column;min-width:0"><span class="ut-needs-name ut-mid" dir="auto">${old ? `<span class="ut-mid-start">${title.slice(0, at)}</span><span class="ut-mid-end">${title.slice(at)}</span>` : midParts(title, at)}</span></span><span style="flex:none;width:60px"></span></li>`).join('')}</ul>`;
        const kinds = result => [...new Set(result.failures.map(f => f.kind))].sort();
        // The regression, in the type of the styles that showed it: the audit says what it is.
        const before = await inspect(strip(piecesBefore, 230, '700 17px/22px monospace', true));
        assert.ok(before.failures.some(f => f.kind === 'title-letters-eaten' && f.element.text === 'Split lunch and dinner shifts'), JSON.stringify(kinds(before)));
        assert.ok(before.failures.some(f => /^title-(letters-eaten|cut-without-ellipsis|halves-joined)$/.test(f.kind) && f.element.text === 'Token auth examples'), JSON.stringify(before.failures));
        // Two halves painted on the same pixels are told too.
        const over = await inspect(strip(`${pieces}.ut-mid>.ut-mid-end{margin-inline-start:-30px}`, 230, '700 17px/22px monospace'));
        assert.ok(over.failures.some(f => f.kind === 'title-halves-overlap'));
        // The app's pieces: any width of the strip, small and large type, any script.
        for (const font of ['600 15px/20px sans-serif', '700 17px/22px monospace', '800 19px/24px sans-serif', '700 22px/28px monospace']) {
          for (const width of [120, 150, 190, 230, 270, 330, 380, 900]) {
            const result = await inspect(strip(pieces, width, font));
            assert.deepEqual(result.failures, [], `${font} at ${width}px`);
            assert.equal(result.checks.midCuts, titles.length);
            const read = await page.locator('.ut-needs-name').evaluateAll(list => list.map(el => {
              const start = el.querySelector('.ut-mid-start'), end = el.querySelector('.ut-mid-end');
              const box = end.getBoundingClientRect();
              const line = el.getBoundingClientRect();
              // On the title's one line and inside the end's box: not wrapped out of sight.
              const words = [...end.children].filter(word => { const r = word.getBoundingClientRect(); return r.top >= line.top - 1 && r.bottom <= Math.min(box.bottom, line.bottom) + 1; });
              return { room: el.clientWidth, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), startCut: start.scrollWidth > start.clientWidth + 1, words: words.length, all: end.children.length, leave: end.hasAttribute('data-leave'), widest: Math.max(...[...end.children].map(word => word.getBoundingClientRect().width)), least: parseFloat(getComputedStyle(start).flexBasis), endRoom: el.clientWidth - parseFloat(getComputedStyle(start).flexBasis) - [...end.children].reduce((sum, word) => sum + word.getBoundingClientRect().width, 0), fits: start.scrollWidth + [...end.children].reduce((sum, word) => sum + word.getBoundingClientRect().width, 0) <= el.clientWidth };
            }));
            for (const [index, title] of read.entries()) {
              const what = `${titles[index][0]}, ${font} at ${width}px`;
              assert.equal(title.height, title.line, `one line: ${what}`);
              // With no room for a word of the end beside the start's «…», a title cut at its end.
              if (title.words === 0) assert.ok(title.leave && title.startCut, `cut at its end, with «…»: ${what}`);
              if (!title.leave || title.widest + title.least <= title.room - 0.5) assert.ok(title.words >= 1, `the end is there: ${what}`);
              // The end gives up a word only once the start is down to its «…».
              if (title.words > 0 && title.words < title.all) assert.ok(title.startCut, `start cut before the end: ${what}`);
              // The end is whole wherever it fits beside the least of the start.
              if (title.endRoom >= 0.5) assert.equal(title.words, title.all, `whole end: ${what}`);
              // A title with room is whole.
              if (title.fits) assert.ok(!title.startCut && title.words === title.all, `whole: ${what}`);
            }
          }
        }
        // Where there is room for the end, the end is whole and the start is what is cut.
        await inspect(strip(pieces, 330, '700 17px/22px monospace'));
        assert.deepEqual(await page.locator('.ut-needs-name').evaluateAll(list => list.slice(1, 3).map(el => { const end = el.querySelector('.ut-mid-end'), start = el.querySelector('.ut-mid-start'); return [start.scrollWidth > start.clientWidth + 1, [...end.children].every(word => Math.abs(word.getBoundingClientRect().top - el.getBoundingClientRect().top) < 1)]; })), [[true, true], [true, true]]);
      });
      await t.test('fixed chrome is not clipped by an ancestor outside its containing block', async () => {
        const good = await inspect('<div style="width:0;height:0;overflow:hidden"><header style="position:fixed;inset:0 0 auto;height:52px"><button style="height:32px">Visible</button></header></div>');
        assert.deepEqual(good.failures, []);
        const bad = await inspect('<div style="position:relative;width:0;height:0;overflow:hidden"><button style="position:absolute;height:32px;width:80px">Clipped</button></div>');
        assert.ok(bad.failures.some(f => f.kind === 'ancestor-clipping'));
      });
      await t.test('a close in a card\'s corner paints no box of its own', async () => {
        // The 2026-11-11 card: a square key flush in the rounded corner, its base cutting the card.
        const card = close => `<section style="display:flex;align-items:flex-start;width:300px;height:70px;margin:20px;border-radius:24px;overflow:hidden;background:#fff5e6"><div style="flex:1">Mientras no estabas</div>${close}</section>`;
        const key = await inspect(card('<button aria-label="Descartar" style="width:44px;height:44px;background:#eee8ff;box-shadow:inset 0 0 0 1px #c9b8f2, 0 3px 0 #b9a6e8">×</button>'));
        const told = key.failures.find(f => f.kind === 'corner-close-box');
        assert.deepEqual(told?.paints, ['box-shadow', 'background-color'], JSON.stringify(key.failures));
        assert.equal(told.corner, 'top-right');
        const edged = await inspect(card('<button data-testid="away-dismiss" style="width:44px;height:44px;background:none;border-left:1px solid #c9b8f2;border-bottom:2px solid #c9b8f2">×</button>'));
        assert.deepEqual(edged.failures.find(f => f.kind === 'corner-close-box')?.paints, ['border']);
        // Flat on its card, an empty shadow token and all: nothing to tell.
        const flat = await inspect(card('<button aria-label="Cerrar" style="width:44px;height:44px;background:transparent;box-shadow:0 0 transparent">×</button>'));
        assert.equal(flat.checks.cornerCloses, 1);
        assert.deepEqual(flat.failures, []);
        // A round face has no straight side, and a key set apart from the corner is its own piece.
        const round = await inspect(card('<button aria-label="Cerrar" style="width:44px;height:44px;border-radius:50%;background:#eee8ff;box-shadow:0 3px 0 #b9a6e8">×</button>'));
        assert.deepEqual(round.failures, []);
        const apart = await inspect(card('<button aria-label="Cerrar" style="width:32px;height:32px;margin:10px;background:#eee8ff;box-shadow:0 3px 0 #b9a6e8">×</button>'));
        assert.equal(apart.checks.cornerCloses, 0);
        assert.deepEqual(apart.failures, []);
      });
      await t.test('material corners match their host across shadow roots', async () => {
        await inspect('<div id="host"></div>');
        await page.locator('#host').evaluate(el => {
          el.attachShadow({ mode: 'open' }).innerHTML = '<style>.ut-surface--material{position:relative;border-radius:25px;height:100px}.ut-surface--material::before{content:"";position:absolute;z-index:-1;inset:-2px;border-radius:8px}</style><div class="ut-surface--material"></div>';
        });
        const bad = await page.evaluate(inspectUILayout);
        assert.ok(bad.failures.some(f => f.kind === 'material-radius-mismatch'));
        assert.ok(bad.failures.some(f => f.kind === 'material-negative-inset'));
        await page.locator('#host').evaluate(el => {
          el.shadowRoot.querySelector('style').textContent += '.ut-surface--material::before{inset:0;border-radius:inherit}';
        });
        assert.deepEqual((await page.evaluate(inspectUILayout)).failures, []);
      });
      await t.test('a rounded nine-slice border or independent clip is rejected', async () => {
        const bad = await inspect('<style>.ut-surface--material{position:relative;border-radius:25px;height:100px}.ut-surface--material::after{content:"";position:absolute;z-index:-1;inset:0;border-radius:inherit;border-image-source:linear-gradient(red,blue);clip-path:inset(0 round 8px)}</style><div class="ut-surface--material"></div>');
        assert.ok(bad.failures.some(f => f.kind === 'material-unclipped-border-image'));
        assert.ok(bad.failures.some(f => f.kind === 'material-independent-clip'));
      });
      // 2026-11-11, the desktop home: a project with one task took two columns of the grid.
      await t.test('a desktop project is as wide as its cards, and its name gets the header\'s room first', async () => {
        await page.setViewportSize({ width: 1280, height: 800 });
        const grid = (span, name, rule) => `<style>.g{display:grid;grid-template-columns:repeat(3,300px);gap:16px}.ut-group-block{display:grid;grid-template-columns:subgrid}.ut-repo-head{grid-column:1/-1;display:flex;height:28px}.ut-repo-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}session-card{display:block;height:60px}</style>
          <div class="g"><div class="ut-group-block" data-group-key="/repos/app" style="grid-column:span ${span}"><div class="ut-repo-head"><span class="ut-repo-name" style="${name}">ia-soberana-espana</span><span class="ut-repo-rule" style="${rule}"></span><button style="flex:none;height:28px">Orquestador</button></div><session-card></session-card></div>
          <div class="ut-group-block" data-group-key="" style="grid-column:1/-1"><div class="ut-repo-head"><span class="ut-repo-name">Sin repositorio</span></div><session-card></session-card></div></div>`;
        const wide = await inspect(grid(2, '', 'flex:1'));
        assert.deepEqual(wide.failures.map(f => f.kind), ['project-header-wider-than-cards']);
        assert.equal(wide.checks.projectBlocks, 1);
        // «Sin repositorio» keeps its whole row; a project of one column with its name whole passes.
        assert.deepEqual((await inspect(grid(1, 'flex:none', 'flex:1'))).failures, []);
        // The name cut while its row's hairline still has room, or beside a button's word.
        assert.deepEqual((await inspect(grid(1, 'width:20px;flex:none', 'flex:1'))).failures.map(f => f.kind), ['project-name-cut-with-room']);
        assert.deepEqual((await inspect(grid(1, 'width:20px;flex:none', 'display:none'))).failures.map(f => f.kind), ['project-name-cut-beside-labels']);
        await page.setViewportSize({ width: 390, height: 844 });
      });
      await t.test('the sections that fold wear one header', async () => {
        const css = '<style>.ut-section-head{display:flex;align-items:center}.ut-section-head::after{content:"";flex:1;height:1px;background:#888}.ut-section-toggle{display:inline-flex;align-items:center;height:28px;font:600 13px/18px sans-serif;color:#333;background:none}svg{width:14px;height:14px}</style>';
        const shared = (id, label) => `<div class="ut-section-head"><button class="ut-section-toggle" data-testid="${id}" aria-expanded="false"><svg></svg>${label}</button></div>`;
        const good = await inspect(`${css}${shared('suspended-section-toggle', 'Suspendidas (1)')}${shared('done-toggle', 'Hechas (20)')}${shared('exited-section-toggle', 'Terminadas (38)')}`);
        assert.deepEqual(good.failures, []);
        assert.equal(good.checks.sectionHeads, 3);
        // As it was: the phone's eyebrow with no styles, the chevron a block under its words.
        const bad = await inspect(`${css}<div><button data-testid="done-toggle" aria-expanded="false" style="font:400 13px sans-serif;background:none;text-align:left"><span>Hechas (20)</span><svg style="display:block"></svg></button></div>${shared('exited-section-toggle', 'Terminadas (38)')}`);
        assert.deepEqual(bad.failures.map(f => f.kind).sort(), ['section-chevron-off-its-line', 'section-headers-differ']);
      });
      // 2026-11-12, a task's session in Clay beside the open sidebar: the branch chip on the
      // path, the capture button on «worktree», both inside the room of the controls.
      await t.test('no piece of a session header is painted over another, at any width', async () => {
        const chips = '.ut-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:12px;background:#fec;box-shadow:0 3px 0 #c96;font:12px/16px monospace;white-space:nowrap}.act{flex:none;width:32px;height:32px;border-radius:16px;background:#fec}.ut-session-header-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
        const branch = 'ut/apps-con-servidor-por-defecto-y-vista-previa-en-la-cabecera';
        const header = (width, css, badge) => `<style>${pieces}${chips}${css}</style><div style="width:${width}px"><div class="ut-session-header session-header-container">
          <div class="ut-session-header-title"><div class="ut-session-header-line1"><span class="ut-session-header-name">Servidor por defecto en apps</span></div>
          <div class="ut-session-header-line2"><clickable-path class="ut-session-header-path"><div class="ut-path-middle"><span class="ut-path-head">~/Projects/.untether-worktrees/untether</span><span class="ut-path-tail">/apps-con-servidor-por-defecto</span></div></clickable-path>
          <git-status-badge>${badge(`<span class="ut-chip ut-git-branch"><span class="ut-mid">${midParts(branch, branch.length - 18)}</span></span><span class="ut-chip ut-git-extra">worktree</span><span class="ut-git-extra">●16</span><span class="ut-git-extra">+1284 −367</span>`)}</git-status-badge></div></div>
          <div class="ut-session-header-actions"><button class="act" aria-label="Captura"></button><button class="act" aria-label="Archivos"></button><button class="act" aria-label="Más"></button></div></div></div>`;
        const overlaps = result => result.failures.filter(f => f.kind === 'header-pieces-overlap');
        // As it was: the badge one box that could not shrink below its chips, the line open.
        const before = '.ut-session-header{display:flex;align-items:center;gap:6px;height:44px}.ut-session-header-title{display:flex;flex:1 1 auto;flex-direction:column;min-width:0}.ut-session-header-line2{display:flex;align-items:center;gap:8px;min-width:0;height:20px}.ut-session-header-path{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap}git-status-badge{min-width:0;flex-shrink:1}.box{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}.ut-git-branch{min-width:0;overflow:hidden}.ut-session-header-actions{display:flex;flex:none;gap:2px}';
        await page.setViewportSize({ width: 1400, height: 400 });
        const bad = await inspect(header(260, before, inner => `<div class="box">${inner}</div>`));
        assert.ok(overlaps(bad).some(f => /Captura/.test(`${f.element.text}${f.other.text}`)), JSON.stringify(bad.failures));
        assert.ok(bad.checks.headerPieces >= 8);
        // The app's own piece: from a window where all of it fits down to a stub.
        for (const width of [1300, 900, 700, 520, 440, 360, 280, 200, 140]) {
          const good = await inspect(header(width, headerPiece, inner => inner));
          assert.deepEqual(good.failures, [], `at ${width}px: ${JSON.stringify(good.failures)}`);
        }
        // Who gave way: the path first, then the branch, the counts and the worktree chip last.
        const shown = width => page.setContent(`<meta name="viewport" content="width=device-width"><style>body{margin:0}button{border:0;box-sizing:border-box}</style>${header(width, headerPiece, inner => inner)}`).then(() => page.evaluate(() => {
          const line = document.querySelector('.ut-session-header-line2').getBoundingClientRect();
          const on = el => el.getBoundingClientRect().top < line.bottom;
          const cut = el => el.scrollWidth > el.clientWidth + 1;
          return { path: cut(document.querySelector('.ut-path-head')), branch: cut(document.querySelector('.ut-mid-start')), extras: [...document.querySelectorAll('.ut-git-extra')].filter(on).length };
        }));
        assert.deepEqual(await shown(1300), { path: false, branch: false, extras: 3 });
        assert.deepEqual(await shown(1000), { path: true, branch: false, extras: 3 });
        assert.deepEqual(await shown(700), { path: true, branch: true, extras: 3 });
        assert.equal((await shown(360)).extras < 3, true);
        await page.setViewportSize({ width: 390, height: 844 });
      });
      await t.test('a title on two tight lines is not two halves on one', async () => {
        // WebKit's glyph boxes are taller than a 1.16 line and reach into the line above (here, 3 px).
        const good = await inspect('<div style="width:300px"><span class="x" style="display:flex;flex-wrap:wrap;font:600 18px/1.16 sans-serif;white-space:pre"><span class="ut-mid-start">Separar los turnos</span><span class="ut-mid-end" style="flex-basis:100%;position:relative;top:-3px">de comida y cena</span></span></div>');
        assert.deepEqual(good.failures.filter(f => f.kind === 'title-halves-overlap'), []);
      });
    } finally { await browser.close(); }
  });
}
