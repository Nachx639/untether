// Browser-side invariants shared by every look. Run in the real twin after fonts/layout settle.
// Scrollable content may enter/leave the viewport; fixed chrome and a row's own controls may not.
export function inspectUILayout({ safeArea } = {}) {
  const failures = [];
  const checks = { controls: 0, containers: 0, text: 0, avatars: 0, primary: 0, selected: 0, material: 0, projectHeads: 0, projectDividers: 0, foldedProjects: 0, cornerCloses: 0 };
  const parent = el => el.parentElement || el.getRootNode().host;
  const ancestors = el => { const found = []; for (let p = parent(el); p; p = parent(p)) found.push(p); return found; };
  const all = [];
  const walk = root => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const interactive = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"]';
  const owner = '.ut-menu,.ut-dialog,.ut-surface--floating,[role="toolbar"],[role="row"],.ut-surface--bar,.ut-surface--well,.ut-row,.ut-card,.ut-tabbar,.ut-action-bar,.psr,.tsk,.prj-head,.ut-phone-section,.p-sheet-header,.st-root-row';
  const label = el => ({ tag: el.tagName.toLowerCase(), id: el.getAttribute('data-testid') || el.id || undefined, classes: el.getAttribute('class'), text: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) });
  const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const outside = (r, box, axes = ['x', 'y']) => axes.filter(axis => axis === 'x' ? r.left < box.left - 1 || r.right > box.right + 1 : r.top < box.top - 1 || r.bottom > box.bottom + 1);
  const visible = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible' &&
      ![el, ...ancestors(el)].some(p => getComputedStyle(p).display === 'none' || Number(getComputedStyle(p).opacity) === 0) &&
      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  // Include the solid relief and half its blur, without treating every faint shadow pixel as a box.
  const painted = el => {
    const r = rect(el);
    for (const shadow of getComputedStyle(el).boxShadow.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, '').split(',')) {
      if (shadow.includes('inset')) continue;
      const [x, y, blur = 0, spread = 0] = (shadow.match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (x === undefined || y === undefined) continue;
      const extent = Math.max(0, blur / 2 + spread);
      const b = rect(el);
      r.left = Math.min(r.left, b.left + x - extent); r.right = Math.max(r.right, b.right + x + extent);
      r.top = Math.min(r.top, b.top + y - extent); r.bottom = Math.max(r.bottom, b.bottom + y + extent);
    }
    return r;
  };
  const controls = all.filter(el => el.matches(interactive) && visible(el));
  for (const el of controls) {
    const chain = ancestors(el);
    const r = rect(el);
    const paint = painted(el);
    // An intentionally scrolling ancestor must actually have scroll range on that axis.
    const scrolling = (axis, limit = chain.length) => chain.slice(0, limit).some((p, index) => {
      if ([el, ...chain.slice(0, index)].some(n => /fixed|sticky/.test(getComputedStyle(n).position))) return false;
      const s = getComputedStyle(p);
      return /auto|scroll/.test(axis === 'x' ? s.overflowX : s.overflowY) &&
        (axis === 'x' ? p.scrollWidth > p.clientWidth + 1 : p.scrollHeight > p.clientHeight + 1) &&
        outside(paint, rect(p), [axis]).length;
    });
    const axes = ['x', 'y'].filter(axis => !scrolling(axis));
    checks.controls++;
    const edges = outside(paint, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, axes);
    if (edges.length) failures.push({ kind: 'viewport-clipping', element: label(el), axes: edges, rect: r, paint });
    // Only inspect row controls when the row itself is on screen, not its scrolled-away content.
    const container = chain.find(p => p.matches(owner));
    if (safeArea && container?.matches('.ut-surface--bar,.ut-tabbar') && outside(r, { left: 0, top: safeArea.top, right: innerWidth, bottom: innerHeight - safeArea.bottom }).length) {
      failures.push({ kind: 'safe-area-overlap', element: label(el), rect: r, safeArea });
    }
    if (container) {
      checks.containers++;
      // data-ut-optical-edge (2026-11-11): a 44 px hit target may hang its empty padding past
      // its container so the glyph sits on the container's edge. Then the glyph, not the box, is
      // held to the container; the box stays held to the window by the viewport check above.
      const glyph = el.hasAttribute('data-ut-optical-edge') && [...el.querySelectorAll('svg,img')].filter(visible).map(rect);
      const subject = glyph?.length ? { left: Math.min(...glyph.map(g => g.left)), top: Math.min(...glyph.map(g => g.top)), right: Math.max(...glyph.map(g => g.right)), bottom: Math.max(...glyph.map(g => g.bottom)) } : paint;
      const edges = outside(subject, rect(container), ['x', 'y'].filter(axis => !scrolling(axis, chain.indexOf(container))));
      if (edges.length) failures.push({ kind: 'control-outside-container', element: label(el), container: label(container), axes: edges, rect: r, paint, bounds: rect(container) });
    }
    for (const p of chain) {
      const s = getComputedStyle(p);
      if (s.display === 'contents') continue;
      // Overflow only clips out-of-flow descendants whose containing block is inside it.
      // Session views host fixed chrome but have no box themselves on a phone.
      const escaped = [el, ...chain.slice(0, chain.indexOf(p))].some(node => {
        // Native top-layer dialogs/popovers escape containing blocks as well as overflow.
        if (node.matches(':modal, :popover-open')) return true;
        const position = getComputedStyle(node).position;
        if (position !== 'fixed' && position !== 'absolute') return false;
        const block = ancestors(node).find(a => {
          const css = getComputedStyle(a);
          return (position === 'absolute' && css.position !== 'static') || css.transform !== 'none' || css.perspective !== 'none' || /paint|layout|strict|content/.test(css.contain);
        });
        return !block || (block !== p && !ancestors(block).includes(p));
      });
      if (escaped) continue;
      const clippedAxes = ['x', 'y'].filter(axis => /hidden|clip/.test(axis === 'x' ? s.overflowX : s.overflowY));
      const edges = outside(r, rect(p), clippedAxes);
      if (edges.length && !edges.every(axis => scrolling(axis))) {
        failures.push({ kind: 'ancestor-clipping', element: label(el), container: label(p), axes: edges, rect: r, bounds: rect(p) });
        break;
      }
    }
  }
  // A control's own words stay inside its face and off its siblings (2026-11-09: Clay gave the
  // labelled "Orquestador" an icon's fixed width; its word ran over "+ Tarea"). Measured on the
  // glyph boxes that are actually painted: clipped or screen-reader-only text is not on screen.
  const glyphs = el => {
    const boxes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim()) continue;
      const inner = [];
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) inner.push(p);
      if (inner.some(p => p !== node.parentElement && p.matches(interactive))) continue;
      const styles = [...inner, el].map(p => [p, getComputedStyle(p)]);
      if (styles.some(([, s]) => s.display === 'none' || Number(s.opacity) === 0) || styles.slice(0, -1).some(([, s]) => s.clipPath !== 'none') || styles[0][1].visibility !== 'visible') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        const r = { left: line.left, top: line.top, right: line.right, bottom: line.bottom };
        for (const [p, s] of styles) {
          const b = rect(p);
          if (/hidden|clip|auto|scroll/.test(s.overflowX)) { r.left = Math.max(r.left, b.left); r.right = Math.min(r.right, b.right); }
          if (/hidden|clip|auto|scroll/.test(s.overflowY)) { r.top = Math.max(r.top, b.top); r.bottom = Math.min(r.bottom, b.bottom); }
        }
        if (r.right - r.left > 1 && r.bottom - r.top > 1) boxes.push(r);
      }
    }
    return boxes;
  };
  for (const el of controls.filter(el => !el.matches('input,select,textarea'))) {
    const boxes = glyphs(el);
    if (!boxes.length) continue;
    checks.text++;
    const r = rect(el);
    const text = { left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)) };
    // Horizontal only: a line box is legitimately taller than a short face, never wider.
    if (outside(text, r, ['x']).length) failures.push({ kind: 'text-outside-control', element: label(el), rect: r, text });
    // Against what the sibling shows (its words and icons), not its box: a touch target may
    // reach over a neighbour's line on purpose (the row's "Te necesita" under its title).
    const shown = p => [...glyphs(p), ...[...p.querySelectorAll('svg,img')].filter(visible).map(rect)];
    const hit = controls.find(p => p !== el && parent(p) === parent(el) && shown(p).some(s => boxes.some(b => Math.min(b.right, s.right) - Math.max(b.left, s.left) > 1 && Math.min(b.bottom, s.bottom) - Math.max(b.top, s.top) > 1)));
    if (hit) failures.push({ kind: 'text-over-sibling', element: label(el), sibling: label(hit), rect: r, text, bounds: rect(hit) });
  }
  // A project's header gives its room to the project's name first (2026-11-10: a real iPhone
  // read "UNT…" beside "Orquestador" and "+ Tarea" in full). While any other word of the header
  // is on screen the name is whole; cut for lack of room, it still tells the projects apart.
  // Wherever the list is scrolled to: a header's geometry does not depend on being in view.
  const laidOut = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // The desktop grid's header too (2026-11-11: one column wide, «b…» and «ia-s…» beside
  // "Orquestador" and "+ Tarea" in full), and there never with its hairline still showing:
  // that is room of its own row the name did not get.
  for (const head of all.filter(el => el.matches('.prj-head,.ut-repo-head:not(.ut-repo-head--compact)') && laidOut(el))) {
    const name = head.querySelector('.prj-name,.ut-repo-name');
    if (!name) continue;
    checks.projectHeads++;
    const cut = [name, ...name.querySelectorAll('*')].some(el => el.scrollWidth > el.clientWidth + 1);
    if (!cut) continue;
    const free = [...head.querySelectorAll('.ut-repo-rule')].reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
    if (free > 1) { failures.push({ kind: 'project-name-cut-with-room', element: label(name), free, rect: rect(name), bounds: rect(head) }); continue; }
    const words = [...head.querySelectorAll(`${interactive},.prj-branch,.prj-moved,.prj-missing`)]
      .filter(el => !el.contains(name) && laidOut(el) && glyphs(el).length);
    if (words.length) { failures.push({ kind: 'project-name-cut-beside-labels', element: label(name), labels: words.map(label), rect: rect(name), bounds: rect(head) }); continue; }
    const shown = glyphs(name).reduce((sum, b) => sum + b.right - b.left, 0);
    const least = 5 * parseFloat(getComputedStyle(name).fontSize);
    if (shown < least) failures.push({ kind: 'project-name-stub', element: label(name), shown, least, rect: rect(name), bounds: rect(head) });
  }
  // In the desktop grid a project is as wide as its cards (2026-11-11: any project with a task
  // took two columns, so one with a single task and a single session had a header twice as
  // wide as its cards and an empty column beside them, in the middle of the row). Its header
  // ends where its widest row of cards ends; «Sin repositorio» keeps its whole row.
  checks.projectBlocks = 0;
  for (const block of all.filter(el => el.matches('.ut-group-block:not([data-group-key=""])') && laidOut(el))) {
    const head = [...block.querySelectorAll('.ut-repo-head')].find(laidOut);
    const cards = [...block.querySelectorAll('session-card,.tsk')].filter(laidOut).map(rect);
    if (!head || !cards.length) continue;
    checks.projectBlocks++;
    const h = rect(head);
    const span = { left: Math.min(...cards.map(r => r.left)), right: Math.max(...cards.map(r => r.right)) };
    if (h.right > span.right + 1 || h.left < span.left - 1) failures.push({ kind: 'project-header-wider-than-cards', element: label(head), rect: h, cards: span, columns: getComputedStyle(block).gridColumnEnd });
  }
  // The home's sections that fold wear one header (2026-11-11: on the desktop «Hechas» had its
  // chevron on a line under its name and no hairline, beside «Terminadas» with the chevron
  // before the name and the hairline after it).
  checks.sectionHeads = 0;
  const folds = all.filter(el => el.matches('[data-testid="done-toggle"],[data-testid="exited-section-toggle"],[data-testid="suspended-section-toggle"]') && laidOut(el)).map(el => {
    const s = getComputedStyle(el);
    const chevron = el.querySelector('svg');
    const words = glyphs(el);
    const text = words.length ? { left: Math.min(...words.map(b => b.left)), right: Math.max(...words.map(b => b.right)), top: Math.min(...words.map(b => b.top)), bottom: Math.max(...words.map(b => b.bottom)) } : null;
    const c = chevron && rect(chevron);
    const line = getComputedStyle(parent(el), '::after');
    checks.sectionHeads++;
    return { el, look: [s.fontSize, s.fontWeight, s.textTransform, s.letterSpacing, s.color, s.height,
      !c || !text ? 'no chevron' : c.bottom <= text.top + 1 || c.top >= text.bottom - 1 ? 'chevron on another line' : c.right <= text.left + 1 ? 'chevron before' : 'chevron after',
      /none|normal/.test(line.content) ? 'no hairline' : `hairline ${line.height}`].join(' | ') };
  });
  for (const fold of folds.slice(1)) if (fold.look !== folds[0].look) failures.push({ kind: 'section-headers-differ', element: label(fold.el), look: fold.look, other: label(folds[0].el), otherLook: folds[0].look });
  if (folds.some(fold => /another line/.test(fold.look))) failures.push({ kind: 'section-chevron-off-its-line', element: label(folds.find(fold => /another line/.test(fold.look)).el) });
  // Projects are told apart by a line of the style's own, with the air it needs and no more
  // (2026-11-10: a project's header followed the last row of the one before like one more row).
  // The line is the group's ::before; the header does not read as a row either.
  const ink = el => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.textTransform, s.letterSpacing, s.color].join(' '); };
  const title = row => {
    let best;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim() || !laidOut(node.parentElement)) continue;
      if (!best || parseFloat(getComputedStyle(node.parentElement).fontSize) > parseFloat(getComputedStyle(best).fontSize)) best = node.parentElement;
    }
    return best;
  };
  for (const [group, heading, rows, named] of [['.prj', '.prj-head', '.psr,.tsk', '.prj-name'], ['.ut-side-group', '.ut-repo-head', '.ut-side-row', '.ut-section-label,.ut-repo-name']]) {
    const groups = all.filter(el => el.matches(group) && laidOut(el));
    groups.forEach((next, index) => {
      const prev = groups[index - 1];
      const head = [...next.querySelectorAll(heading)].find(laidOut);
      if (!prev || !head || parent(prev) !== parent(next) && parent(parent(prev)) !== parent(parent(next))) return;
      checks.projectDividers++;
      const tops = el => [...el.querySelectorAll(rows)].filter(laidOut).map(rect).sort((a, b) => a.top - b.top);
      const before = tops(prev);
      const last = before.length ? Math.max(...before.map(r => r.bottom)) : rect(prev).bottom;
      const gaps = [before, tops(next)].flatMap(list => list.slice(1).map((r, at) => r.top - list[at].bottom)).filter(gap => gap >= 0);
      const rowGap = gaps.length ? Math.min(...gaps) : 0;
      const line = getComputedStyle(next, '::before');
      const clear = color => /^(transparent|rgba\(0, 0, 0, 0\))$/.test(color);
      const thickness = /none|normal/.test(line.content) || line.display === 'none' || Number(line.opacity) === 0 ? 0
        : line.backgroundImage !== 'none' || !clear(line.backgroundColor) ? parseFloat(line.height) || 0
        : !clear(line.borderTopColor) ? parseFloat(line.borderTopWidth) || 0 : 0;
      const band = rect(head).top - last;
      const where = { element: label(head), after: label(prev), band, rowGap, thickness };
      if (thickness < 0.5) failures.push({ kind: 'project-divider-missing', ...where });
      else if (thickness > 4) failures.push({ kind: 'project-divider-heavy', ...where });
      else if (band < rowGap + thickness + 8) failures.push({ kind: 'project-divider-cramped', ...where });
      const name = head.querySelector(named);
      const row = [...next.querySelectorAll(rows), ...prev.querySelectorAll(rows)].find(laidOut);
      const rowTitle = row && title(row);
      if (name && rowTitle && ink(name) === ink(rowTitle)) failures.push({ kind: 'project-header-like-row', element: label(name), row: label(row), ink: ink(name) });
    });
  }
  // A folded project (2026-11-10: «poder plegar los proyectos, para que no te salgan todos
  // abiertos») shows its header and one line, never a row; its button says it is folded, and
  // what waits for the user in that line is whole, whatever else the width cuts.
  for (const group of all.filter(el => el.matches('.prj[data-folded="true"],.ut-side-group[data-folded="true"]') && laidOut(el))) {
    checks.foldedProjects++;
    const where = { element: label(group) };
    if ([...group.querySelectorAll('.psr,.tsk,.ut-side-row')].some(laidOut)) failures.push({ kind: 'folded-project-shows-rows', ...where });
    const toggle = group.querySelector('.ut-fold-toggle');
    if (!toggle || !laidOut(toggle) || toggle.getAttribute('aria-expanded') !== 'false') failures.push({ kind: 'folded-project-no-toggle', ...where });
    const summary = group.querySelector('.ut-fold-summary');
    if (!summary || !laidOut(summary) || !summary.textContent.trim()) { failures.push({ kind: 'folded-project-no-summary', ...where }); continue; }
    const needs = summary.querySelector('.ut-fold-needs');
    if (needs && (rect(needs).right > rect(summary).right + 0.5 || rect(needs).left < rect(summary).left - 0.5)) failures.push({ kind: 'folded-needs-cut', ...where, rect: rect(needs), bounds: rect(summary) });
  }
  // Two rows of one project never read the same while their titles differ (2026-11-10: three
  // queued tasks, «Revisión 2ª vuelta: arreglos claros de…» three times on a phone; their ends
  // told them apart). What a title shows is the characters painted inside its own box and its
  // clipping children; the two before a cut are the ones «…» takes. Wherever the list is.
  const shownText = el => {
    let text = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const boxes = [];
      for (let p = node.parentElement; p; p = p === el ? null : p.parentElement) if (/hidden|clip/.test(getComputedStyle(p).overflowX + getComputedStyle(p).overflowY)) boxes.push(rect(p));
      const range = document.createRange();
      let part = '';
      let cut = false;
      for (let at = 0; at < node.data.length; at++) {
        range.setStart(node, at); range.setEnd(node, at + 1);
        const r = range.getBoundingClientRect();
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        // WebKit gives the characters «…» took an empty box at the «…» itself.
        if (r.right - r.left > 0.01 && boxes.every(b => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)) part += node.data[at];
        else cut = true;
      }
      const ellipsis = cut && /ellipsis/.test(getComputedStyle(node.parentElement).textOverflow) || cut && getComputedStyle(el).webkitLineClamp !== 'none';
      text += ellipsis ? `${part.slice(0, -2)}…` : part;
    }
    return text.replace(/\s+/g, ' ').trim();
  };
  checks.titles = 0;
  const told = new Set();
  for (const [group, titles] of [['.prj,.tsk-grid,.ut-phone-section', '.tsk .psr-title'], ['.ut-side-group', '[data-testid="compact-task-row"] .ut-side-name'], ['.ut-needs', '.ut-needs-name']]) {
    for (const scope of all.filter(el => el.matches(group) && laidOut(el))) {
      const seen = new Map();
      for (const el of [...scope.querySelectorAll(titles)].filter(laidOut)) {
        checks.titles++;
        const whole = el.textContent.replace(/\s+/g, ' ').trim();
        const shown = shownText(el);
        const twin = seen.get(shown);
        if (twin && twin.whole !== whole) { if (!told.has(el)) failures.push({ kind: 'titles-read-the-same', element: label(el), shown, titles: [twin.whole, whole], rect: rect(el) }); told.add(el); }
        else seen.set(shown, { whole });
      }
    }
  }
  // A title cut in the middle reads «start… end» (2026-11-10: in the styles with large type
  // the strip "Te necesita" painted «Tokenh examples» for «Token auth examples» and «Split lu…
  // nd dinner shifts»: the end clipped from its left with no «…»). The two parts never share
  // a pixel; the end loses whole words only, and only beside a start that shows its «…»; the
  // space between them is on screen; a title with room for all of it is whole; and an end
  // with no room at all leaves a title cut at its end, «…» included.
  checks.midCuts = 0;
  const clips = (node, el) => { const boxes = []; for (let p = node.parentElement; p; p = p === el ? null : p.parentElement) if (/hidden|clip/.test(getComputedStyle(p).overflowX + getComputedStyle(p).overflowY)) boxes.push(rect(p)); return boxes; };
  const letters = (part, el) => {
    const found = [];
    const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const boxes = clips(node, el);
      const range = document.createRange();
      // The «…» of the nearest box of the part that cuts its own text.
      let ellipsis = false;
      for (let p = node.parentElement; p && !ellipsis; p = p === part ? null : p.parentElement) { const s = getComputedStyle(p); ellipsis = s.display !== 'inline' && /ellipsis/.test(s.textOverflow) && /hidden|clip/.test(s.overflowX); }
      for (let at = 0; at < node.data.length; at++) {
        range.setStart(node, at); range.setEnd(node, at + 1);
        const r = range.getBoundingClientRect();
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        const inside = r.right - r.left > 0.01 && boxes.every(b => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
        // Whole, not half a letter under the edge of a box that clips it.
        const whole = inside && boxes.every(b => r.left >= b.left - 1.5 && r.right <= b.right + 1.5);
        found.push({ char: node.data[at], node, at, ellipsis, shown: inside, whole, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.right - r.left });
      }
    }
    return found;
  };
  for (const el of all.filter(el => el.querySelector(':scope > .ut-mid-start') && el.querySelector(':scope > .ut-mid-end') && /flex/.test(getComputedStyle(el).display) && laidOut(el))) {
    const start = el.querySelector(':scope > .ut-mid-start'), end = el.querySelector(':scope > .ut-mid-end');
    checks.midCuts++;
    const size = parseFloat(getComputedStyle(el).fontSize);
    const startBox = rect(start);
    const first = letters(start, el), last = letters(end, el);
    const shown = last.filter(c => c.shown);
    const text = `${first.filter(c => c.shown).map(c => c.char).join('')}|${shown.map(c => c.char).join('')}`;
    const where = { element: label(el), shown: text, rect: rect(el) };
    const startCut = start.scrollWidth > start.clientWidth + 1;
    const startTells = startCut && /ellipsis/.test(getComputedStyle(start).textOverflow) && start.clientWidth >= 0.75 * size;
    // Letters of the end out of sight: whole words from its start, or the tail of a word that
    // says so with its own «…». Anything else is a letter eaten in silence.
    // Spaces apart: a space that opens a line has no box, and the gap is measured below.
    const gone = last.filter(c => !c.whole && c.char.trim());
    const firstShown = last.findIndex(c => c.whole && c.char.trim());
    const eaten = gone.filter(c => {
      const index = last.indexOf(c);
      if (firstShown !== -1 && index < firstShown) return !/\s/.test(last[firstShown - 1].char);
      const later = last.filter(o => o.node === c.node && o.at > c.at);
      return !(c.ellipsis && later.every(o => !o.whole || !o.char.trim()));
    });
    // No letter of the end on screen (no room for one beside the start): then the title reads
    // like any title cut at its end, with the start's «…».
    if (firstShown === -1) { if (!startTells) failures.push({ kind: 'title-end-gone', ...where, start: { cut: startCut, width: start.clientWidth } }); }
    else if (eaten.length) failures.push({ kind: 'title-letters-eaten', ...where, eaten: eaten.map(c => c.char).join('') });
    else if (firstShown > 0 && gone.some(c => last.indexOf(c) < firstShown) && !startTells) failures.push({ kind: 'title-cut-without-ellipsis', ...where, start: { cut: startCut, width: start.clientWidth, least: 0.75 * size } });
    // By its middle: WebKit's glyph boxes are taller than a tight line (Cosmos, 1.16) and reach
    // into the line above, so a title on two lines read as two halves on one (2026-11-11).
    const sameLine = c => { const middle = (c.top + c.bottom) / 2; return middle > startBox.top && middle < startBox.bottom; };
    const beside = shown.filter(c => c.char.trim() && sameLine(c));
    if (beside.some(c => Math.min(c.right, startBox.right) - Math.max(c.left, startBox.left) > 1)) failures.push({ kind: 'title-halves-overlap', ...where, start: startBox });
    else if (beside.length && firstShown !== -1) {
      // The space the title has between its two parts: on screen, not a hairline.
      const rtl = getComputedStyle(el).direction === 'rtl';
      const spaced = /\s/.test(end.textContent[0] || '') || /\s$/.test(start.textContent) || firstShown > 0;
      const gap = rtl ? startBox.left - Math.max(...beside.map(c => c.right)) : Math.min(...beside.map(c => c.left)) - startBox.right;
      if (spaced && gap < Math.max(2, 0.12 * size)) failures.push({ kind: 'title-halves-joined', ...where, gap });
    }
    // Room for the whole title, and still cut.
    const others = [...el.children].filter(c => c !== start && c !== end && laidOut(c)).reduce((sum, c) => { const s = getComputedStyle(c); return sum + c.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight); }, 0);
    const need = start.scrollWidth + last.reduce((sum, c) => sum + c.width, 0) + others;
    const endBeside = sameLine({ top: rect(end).top, bottom: rect(end).bottom });
    if (endBeside && need <= el.clientWidth - 1 && (startCut || gone.length)) failures.push({ kind: 'title-cut-with-room', ...where, need, room: el.clientWidth });
    // Its end on a second line while the whole title fits on the first (2026-11-11: WebKit in
    // Comic and Cosmos, a one-line title measured as cut by card-line.ts fitTitleLines).
    // By its letters: on a line of its own the start is as wide as the title, whatever it holds.
    else if (!endBeside && shown.length) {
      const whole = [...first, ...last].reduce((sum, c) => sum + c.width, 0) + others;
      if (whole <= el.clientWidth - 1) failures.push({ kind: 'title-split-with-room', ...where, need: whole, room: el.clientWidth });
    }
  }
  // An avatar and its mark belong to their row, wherever the list has been scrolled to
  // (2026-11-09: marks loose over other rows on a real iPhone). The mark sits on its avatar.
  for (const el of all.filter(el => el.matches('.psr-avatar,.ut-card-avatar,.ut-side-avatar,.ut-switch-avatar') && visible(el))) {
    const row = ancestors(el).find(p => p.matches('.tsk,.psr,.pvr,.ut-card,.ut-srow,[role="row"],[role="option"],li')) || parent(el);
    const r = rect(el);
    const bounds = rect(row);
    checks.avatars++;
    if (outside(r, bounds).length) failures.push({ kind: 'avatar-outside-row', element: label(el), row: label(row), rect: r, bounds });
    for (const mark of el.querySelectorAll('img,svg,.ut-provider-logo')) {
      const m = rect(mark);
      if (m.right <= m.left || getComputedStyle(mark).display === 'none') continue;
      const cx = (m.left + m.right) / 2, cy = (m.top + m.bottom) / 2;
      // One filter per mark: a filtered box around a filtered image is two composited layers that
      // iOS painted apart while scrolling (finished rows: grey over the image's own shadow).
      const filtered = n => getComputedStyle(n).filter !== 'none';
      const around = ancestors(mark).slice(0, ancestors(mark).indexOf(row) + 1).find(filtered);
      if (filtered(mark) && around) failures.push({ kind: 'avatar-nested-filter', element: label(mark), around: label(around), row: label(row), filters: [getComputedStyle(around).filter, getComputedStyle(mark).filter] });
      if (outside(m, bounds).length || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) failures.push({ kind: 'avatar-mark-misplaced', element: label(mark), row: label(row), rect: m, avatar: r, bounds });
    }
  }
  // Check actual resolved paint against peers. Original can express selection through ink;
  // Clay and other filled looks also distinguish their backgrounds. No palette is hard coded.
  const paint = el => { const s = getComputedStyle(el); return { background: s.backgroundColor, ink: s.color }; };
  const filledSelection = !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(getComputedStyle(document.documentElement).getPropertyValue('--ut-tab-selected-bg').trim());
  const same = (a, b, kind) => a.background === b.background && (kind === 'primary' || filledSelection || a.ink === b.ink);
  const selected = '[aria-selected="true"],[aria-current="page"],[aria-pressed="true"]';
  const primary = '.ut-btn--primary,.ut-surface--primary,.ut-tab-new,.psr-reply,.needs-act';
  for (const el of controls) {
    const kind = el.matches(primary) ? 'primary' : el.matches(selected) ? 'selected' : undefined;
    if (!kind) continue;
    const group = ancestors(el).find(p => p.matches('[role="tablist"],[role="group"],nav,.ut-tabbar,.ut-toolbar,.ut-action-bar,.tsk,.psr,.ut-look-grid')) || parent(el);
    const peers = controls.filter(p => p !== el && group.contains(p) && !p.matches(`${primary},${selected}`));
    if (!peers.length) continue;
    checks[kind]++;
    if (peers.every(p => same(paint(p), paint(el), kind))) failures.push({ kind: `${kind}-indistinguishable`, element: label(el), peers: peers.map(label), paint: paint(el) });
  }
  // A close set flush in the corner of a rounded card is a mark on that card, never a box of its
  // own: no edge, base, fill or relief whose straight sides reach the card's border (2026-11-11,
  // «Mientras no estabas» in Playful / 3D and Clay: the × sat in a square key, a line at its left
  // and its base cutting the card under it). A round face has no straight side to cross with.
  const seen = color => { const parts = (color.match(/[\d.]+%?/g) || []).map(parseFloat); return /^(rgb|color|oklch|oklab|lab|lch|hsl)/.test(color.trim()) && (parts.length < 4 || parts[3] > 0.02); };
  const closing = el => /close|dismiss|cerrar|descartar/i.test(`${el.getAttribute('data-testid') || ''} ${el.id} ${el.getAttribute('class') || ''} ${el.getAttribute('aria-label') || ''}`) || /^[×✕✖✗]$/u.test(el.textContent.trim());
  for (const el of controls.filter(closing)) {
    const r = rect(el);
    const own = getComputedStyle(el);
    let corner;
    const card = ancestors(el).find(p => {
      const s = getComputedStyle(p);
      const inner = { left: rect(p).left + parseFloat(s.borderLeftWidth), right: rect(p).right - parseFloat(s.borderRightWidth), top: rect(p).top + parseFloat(s.borderTopWidth), bottom: rect(p).bottom - parseFloat(s.borderBottomWidth) };
      corner = [['Top', 'Left'], ['Top', 'Right'], ['Bottom', 'Left'], ['Bottom', 'Right']].find(([v, h]) =>
        parseFloat(s[`border${v}${h}Radius`]) >= 6 && Math.abs(r[v.toLowerCase()] - inner[v.toLowerCase()]) <= 2 && Math.abs(r[h.toLowerCase()] - inner[h.toLowerCase()]) <= 2);
      return corner;
    });
    if (!card) continue;
    checks.cornerCloses++;
    const round = ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].every(c => parseFloat(own[`border${c}Radius`]) >= Math.min(r.right - r.left, r.bottom - r.top) / 2 - 0.5);
    if (round) continue;
    const paints = [];
    if (['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(own[`border${side}Width`]) > 0 && own[`border${side}Style`] !== 'none' && seen(own[`border${side}Color`]))) paints.push('border');
    if (own.boxShadow !== 'none' && own.boxShadow.split(/,(?![^(]*\))/).some(shadow => seen(shadow.match(/(?:rgba?|color|oklch|oklab|lab|lch|hsl)a?\([^)]*\)/)?.[0] || 'rgb(0, 0, 0)') && (shadow.replace(/\w+\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).some(length => parseFloat(length) !== 0))) paints.push('box-shadow');
    if (own.backgroundImage !== 'none') paints.push('background-image');
    if (seen(own.backgroundColor)) paints.push('background-color');
    if (paints.length) failures.push({ kind: 'corner-close-box', element: label(el), card: label(card), corner: corner.join('-').toLowerCase(), paints, rect: r, bounds: rect(card) });
  }
  for (const el of all.filter(el => el.matches('.ut-surface--material') && visible(el))) {
    const host = getComputedStyle(el);
    for (const pseudo of ['::before', '::after']) {
      const layer = getComputedStyle(el, pseudo);
      // Hit halos and selection marks are not material. Material is the empty paint
      // layer behind content; the same convention is used inside shadow roots.
      if (layer.content === 'none' || layer.content === 'normal' || layer.zIndex !== '-1') continue;
      checks.material++;
      const corners = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'];
      if (corners.some(corner => layer[corner] !== host[corner])) failures.push({ kind: 'material-radius-mismatch', element: label(el), pseudo, host: host.borderRadius, layer: layer.borderRadius });
      if (layer.borderImageSource !== 'none' && corners.some(corner => host[corner] !== '0px')) failures.push({ kind: 'material-unclipped-border-image', element: label(el), pseudo });
      if (layer.clipPath !== 'none') failures.push({ kind: 'material-independent-clip', element: label(el), pseudo, clip: layer.clipPath, radius: host.borderRadius });
      if ([layer.top, layer.right, layer.bottom, layer.left].some(value => parseFloat(value) < 0)) failures.push({ kind: 'material-negative-inset', element: label(el), pseudo });
    }
  }
  // Two bars one over the other are one surface (2026-11-11: the home's header and the list's
  // toolbar each drew their own bottom corners, edge and shadow, and the page's background
  // showed between them at both ends). The one on top is straight below and carries no edge or
  // shadow of its own; nothing of the page shows between the two, at the joint or at the ends.
  checks.stackedBars = 0;
  const bars = all.filter(el => el.matches('.ut-surface--bar') && visible(el));
  const px = value => parseFloat(value) || 0;
  for (const over of bars) {
    const a = rect(over);
    for (const under of bars) {
      if (under === over || over.contains(under) || under.contains(over)) continue;
      const b = rect(under);
      const shared = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      // One under the other: the lower starts where the upper ends (or a sliver below it), and
      // they share most of their width. A bar the list has scrolled under another is not a pair.
      if (b.top < a.bottom - 1.5 || b.top > a.bottom + 8 || shared < 0.8 * Math.min(a.right - a.left, b.right - b.left)) continue;
      checks.stackedBars++;
      const top = getComputedStyle(over), bottom = getComputedStyle(under);
      const where = { element: label(over), under: label(under), rect: a, bounds: b };
      if (b.top - a.bottom > 0.5) failures.push({ kind: 'stacked-bar-gap', ...where, gap: b.top - a.bottom });
      if (Math.abs(a.left - b.left) > 1 || Math.abs(a.right - b.right) > 1) failures.push({ kind: 'stacked-bar-ends-apart', ...where });
      const corners = [top.borderBottomLeftRadius, top.borderBottomRightRadius, bottom.borderTopLeftRadius, bottom.borderTopRightRadius];
      if (corners.some(px)) failures.push({ kind: 'stacked-bar-own-corners', ...where, corners });
      if (top.boxShadow !== 'none') failures.push({ kind: 'stacked-bar-own-edge', ...where, shadow: top.boxShadow });
      if (px(top.borderBottomWidth) > 1.5 || px(top.marginBottom) || px(bottom.marginTop)) failures.push({ kind: 'stacked-bar-own-edge', ...where, border: top.borderBottomWidth });
      // Nor through a layer of its own: a ::before/::after of the bar on top that casts a shadow
      // or rounds its lower corners draws the same edge the bar itself may not.
      for (const pseudo of ['::before', '::after']) {
        const layer = getComputedStyle(over, pseudo);
        if (/^(none|normal)$/.test(layer.content) || layer.display === 'none') continue;
        if (layer.boxShadow !== 'none') failures.push({ kind: 'stacked-bar-own-edge', ...where, pseudo, shadow: layer.boxShadow });
        if (px(layer.borderBottomLeftRadius) || px(layer.borderBottomRightRadius)) failures.push({ kind: 'stacked-bar-own-corners', ...where, pseudo, corners: [layer.borderBottomLeftRadius, layer.borderBottomRightRadius] });
      }
    }
  }
  // In a session's header no piece is painted over another, at any width (2026-11-12: in a
  // task's session in Clay the branch chip sat on the path, the capture button on «worktree»,
  // and both inside the room of the controls on the right; nothing here saw it, the pieces were
  // not controls of one parent). A piece is a control, a chip, a text or a loose icon; what it
  // paints is its box when it has a face of its own (a fill, an edge, a relief) and its words and
  // icons when it has none, inside every box and clip-path of the bar that cuts it. Pieces one inside the
  // other are one piece.
  checks.headerPieces = 0;
  const clipped = (box, el, bar) => {
    const r = { ...box };
    // Up to the bar: what holds a fixed bar does not cut it.
    for (const p of ancestors(el).slice(0, ancestors(el).indexOf(bar) + 1)) {
      const s = getComputedStyle(p);
      if (s.display === 'contents') continue;
      const b = rect(p);
      if (/hidden|clip|auto|scroll/.test(s.overflowX)) { r.left = Math.max(r.left, b.left); r.right = Math.min(r.right, b.right); }
      if (/hidden|clip|auto|scroll/.test(s.overflowY)) { r.top = Math.max(r.top, b.top); r.bottom = Math.min(r.bottom, b.bottom); }
      const inset = /^inset\(([^)]*)\)/.exec(s.clipPath)?.[1].split(/\s+round\s+/)[0].trim().split(/\s+/).map(parseFloat);
      if (inset?.length && inset.every(Number.isFinite)) {
        const [top, right = top, bottom = top, left = right] = inset;
        r.left = Math.max(r.left, b.left + left); r.right = Math.min(r.right, b.right - right);
        r.top = Math.max(r.top, b.top + top); r.bottom = Math.min(r.bottom, b.bottom - bottom);
      }
    }
    return r.right - r.left > 1 && r.bottom - r.top > 1 ? r : null;
  };
  const faced = el => { const s = getComputedStyle(el); return seen(s.backgroundColor) || s.backgroundImage !== 'none' || s.boxShadow !== 'none' || ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none' && seen(s[`border${side}Color`])); };
  const ownText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.data.trim());
  for (const bar of all.filter(el => el.matches('.session-header-container') && visible(el))) {
    const inside = all.filter(el => el !== bar && bar.contains(el) && visible(el));
    const pieces = inside.filter(el => el.matches(`${interactive},.ut-chip,.ut-dot,svg,img`) || ownText(el))
      .filter((el, _, list) => !list.some(other => other !== el && other.contains(el)))
      .map(el => {
        // Of a line of text, its ink: the line box of a 13 px title is 18 px high, and the relief
        // of a chip on the line below may reach into its empty top without touching a letter.
        const size = parseFloat(getComputedStyle(el).fontSize);
        const ink = box => { const spare = Math.max(0, (box.bottom - box.top - 0.8 * size) / 2); return { ...box, top: box.top + spare, bottom: box.bottom - spare }; };
        const boxes = (faced(el) || el.matches('svg,img,.ut-dot') ? [rect(el)] : [...glyphs(el).map(ink), ...[...el.querySelectorAll('svg,img')].filter(visible).map(rect)]).map(box => clipped(box, el, bar)).filter(Boolean);
        return { el, boxes };
      }).filter(piece => piece.boxes.length);
    checks.headerPieces += pieces.length;
    pieces.forEach((piece, index) => {
      for (const other of pieces.slice(index + 1)) {
        const hit = piece.boxes.flatMap(a => other.boxes.map(b => ({ a, b }))).find(({ a, b }) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1);
        if (hit) failures.push({ kind: 'header-pieces-overlap', element: label(piece.el), other: label(other.el), rect: hit.a, bounds: hit.b });
      }
    });
  }
  return { look: document.documentElement.dataset.look || 'original', viewport: { width: innerWidth, height: innerHeight },
    bars: all.filter(el => el.matches('.ut-surface--bar,.ut-tabbar') && visible(el)).map(el => ({ element: label(el), rect: rect(el), paddingTop: getComputedStyle(el).paddingTop, parent: parent(el) ? { rect: rect(parent(el)), paddingTop: getComputedStyle(parent(el)).paddingTop } : null })),
    surfaces: all.filter(el => el.matches('.ut-surface--material') && visible(el)).map(el => ({ element: label(el), rect: rect(el) })),
    checks, failures };
}
