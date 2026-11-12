# UI tokens and shared pieces

Everything the web interface looks like comes from the variables of
`web/src/client/styles/tokens.css` and a few shared classes. A style is one small file that gives those variables other
values; adding a screen must not mean writing it 25 times.

**Rule for agents: use tokens and shared pieces; never hand-write colors, radii or shadows.** Tailwind classes that read
the tokens (`bg-bg-secondary`, `text-text-muted`, `rounded-ctl`, `shadow-e2`) count as tokens.
`web/src/client/ui-tokens-guard.test.ts` fails on a new literal.

## How it fits together

- `styles/tokens.css` is the only file with hand-written values: the light palette and the rest of the tokens in the
  first `:root`, then `[data-theme="dark"]`, the system-dark copy, and `[data-accent="…"]` (with
  `[data-theme="dark"][data-accent="…"]`). Tailwind's `@theme` lives there too.
- The rest of the app's stylesheet is split by piece, one file each (2026-11-11: tasks changing different pieces
  met in the same two huge files). `styles.css` only lists its parts, in the order of the cascade:
  `styles/foundation/*.css` (variables, the base layer, the shared pieces in `ut-*.css`, then one file per zone:
  `terminal.css`, `phone-rows.css`, `avatars.css`, `composer.css`, `sheet-*.css`, `preview-*.css`…), the four areas
  (`styles/list.css`, `session.css`, `dialogs.css`, `layout.css`) and `styles/material.css`. `styles/list.css` is a
  list too, of `styles/list/*.css`: `desktop-*.css` (toolbar, «Te necesita», project header, session card, list
  view), `sidebar-rows.css`, `phone-*.css` (container, «Te necesita», session row, tab bar, composer…),
  `project-header.css`, `orchestrator.css`, `task-row.css`, `task-details.css`, `task-sheets.css`… Change a piece
  in its own file; a new piece is a new file and its `@import` line where its rules belong in the order. Files that
  share a block (`@layer components` in `ut-*.css` and `desktop-*.css`, the phone's `@media` in `phone-*.css`) each
  open and close it themselves. Tests read a whole sheet with `web/src/test/utils/stylesheets.ts`, never one piece's file.
- The `--ut-*` names are the stable layer: they hold the values. The older `--color-*`, `--radius-*`, `--shadow-*`,
  `--font-*`, `--dur-*` and `--ease-*` names, which Tailwind's classes and existing CSS read, are aliases of them and hold
  no value of their own. A style sets only `--ut-*`.
- Light/dark and the accents (`utils/theme-mode.ts`, `utils/accent-themes.ts`) keep working as before: they set
  `data-theme` and `data-accent` on `<html>`, and those blocks set `--ut-*`.

### Adding a style

Three things: an entry in `web/src/shared/looks.ts` (id, supported modes, group, swatches, `fixedAccent`, `effects`,
`backgrounds`), the name and description in the 8 locales (`look.<id>.name`, `look.<id>.desc`), and
`web/src/client/styles/looks/<id>.css`:

```css
[data-look="<id>"] {
  --ut-r-lg: 0;
}
[data-look="<id>"][data-theme="dark"] {
  --ut-bg-app: #101010;
  --ut-accent: #ff00aa; /* only with fixedAccent */
}
[data-look="<id>"][data-theme="light"] {
  --ut-bg-app: #fafafa;
}
```

- The base block holds what does not depend on the mode (radii, type, elevation). **Colors go in the
  `[data-theme="…"]` blocks** (one per supported mode): the accent's tinted dark backgrounds and the system-dark block
  win over a one-attribute selector, so a color in the base block would show or not depending on the OS (`looks.test.ts`
  fails on one).
- `--ut-bg-app` must equal `backgrounds` in the registry: it is painted before any file loads and sent to the browser
  chrome. `--ut-bg-app` is always a plain color.
- Optional effects: `styles/looks/<id>.effects.css` with `effects: true`, rules of the shape
  `html[data-look="<id>"] .ut-btn--primary { box-shadow: var(--ut-effect-glow); }`, only on the shared pieces (`.ut-surface`,
  `.ut-card`, `.ut-btn`, `.ut-chip`, `.ut-field`, `.ut-select`, `.ut-switch`, `.ut-dialog`, `.ut-menu`, `.ut-toast`, …) and only
  borders, backgrounds, outlines, shadows, `backdrop-filter` and `color`. Never `filter`, `opacity` or `mix-blend-mode`, which
  would repaint what is inside (logos, avatars). The picker's miniatures read `--ut-effect-glow`, not the layer.
- `web/src/client/looks.test.ts` and `theme-contrast.test.ts` read the registry: a new style is checked with no test changes
  (texts, files, contrast in its modes and, unless it fixes the accent, with every accent).
- The build joins the file and its layer into `public/looks/<id>.css` (`scripts/copy-assets.js`). Only the active style's
  sheet is loaded, plus all of them while Appearance shows its miniatures.

### Backdrops and effects

All generic and neutral by default, so a style that does not set them changes nothing. `--ut-bg-app` stays a plain color (first
paint, browser chrome, the terminal's background); the rest is painted over it.

| Token | What it does |
| --- | --- |
| `--ut-backdrop` | `background-image` of `body`: CSS gradients, or a small `data:` tile like `--ut-grain` (or a local raster tile, see Material surfaces below). `body` never scrolls, so it stays fixed behind everything. Colors go in the `[data-theme]` blocks |
| `--ut-backdrop-size`, `--ut-backdrop-position`, `--ut-backdrop-repeat` | `background-size`, `-position`, `-repeat` of that layer, comma separated like its gradients: a stepped meadow is several rows of hard-stop gradients |
| `--ut-page-alpha` | How much of `--ut-bg-app` covers the backdrop on the page itself (`--color-page`: list rows, tasks). 100 % hides the backdrop |
| `--ut-surface-alpha` | Opacity of rows, cards and panels over the page (`--color-bg-secondary`, `-bg-tertiary`, `-surface`, `-card`) |
| `--ut-chrome-alpha` | Opacity of the phone header, with the list scrolling under it. Solid surface, never `--ut-surface-alpha`; a style with hard black edges sets 100 % |
| `--ut-session-bar` | Solid top bar of a session (terminal mode), safe area included. `--ut-terminal-bg` in Original, `--ut-surface-1` in every other style (`:root[data-look]`), `--color-bg` while the phone's chat covers the terminal. Guarded in `ui-tokens-guard.test.ts` |
| `--ut-panel-alpha` + `--ut-blur-surface` | Floating pieces over content (`--color-float`: dialogs, sheets, menus, toasts, tooltips), frosted with `backdrop-filter` |
| `--ut-outline-width` | Border width of `.ut-btn`, `.ut-field`, `.ut-card`, `.ut-group` |
| `--ut-surface-edge` | `box-shadow` of `.ut-card` and `.ut-group`: edge of light, bevel, relief, glow |
| `--ut-control-relief`, `--ut-control-sheen`, `--ut-field-relief` | Shadows and sheen for raised controls and sunken fields, read from a style's effects layer |
| `--ut-effect-glow` | Glow of the main action and focus, from the effects layer |
| `--ut-grain` | `background-image` over rows, top bars, the list panel and the pieces a style names: one small tile (a `data:` SVG in the values file) that reads as the material. Never a filter over a container |
| `--ut-bar-fill`, `--ut-bar-relief` | The app's top bars (phone, sidebar, home): `background-image`, a one-color gradient to stay solid, and `box-shadow`. `--ut-bar-relief` also covers the session's bar |
| `--ut-bar-seam` | Two bars one over the other are one surface (2026-11-11: the desktop home's header and the list's toolbar each drew their own bottom corners, edge and shadow, and the page showed between them at both ends). The bar on top is `.ut-surface--bar-over` (`styles/material.css`): straight below, no `box-shadow`, and its 1 px bottom line takes this color, the fillet inside the surface (`transparent` for none; optional and unset by default: it falls back to `--color-border` where it is used, so it follows any scope that changes the palette). The last bar keeps the style's radius, edge and shadow. The home's header takes the piece by itself while a list toolbar follows it (whatever box wraps the list); any other stack adds the class. No style paints the joint by hand: the piece is stronger than a style's `.ut-surface--bar` rule, and `--audit-layout` fails with `stacked-bar-own-corners`, `stacked-bar-own-edge`, `stacked-bar-gap` or `stacked-bar-ends-apart`; see it with `--views desktop-home,desktop-home-wide` (1440 and 2000 px) |
| `--ut-composer-relief`, `--ut-action-relief`, `--ut-banner-relief` | `box-shadow` of the "what to do" box, of the main actions outside `.ut-btn` (row buttons, Nueva, Blindar) and of a list banner |
| `--ut-press-offset` | How far a `.ut-btn` sinks while pressed |
| `--ut-tab-selected-bg`, `-shadow` | The current tab of the phone's tab bar |
| `--ut-status-working-dot` | The "working" dot, for a style whose top bar is close to its accent |
| `--ut-row-selected-mark`, `-selected-shadow` | The stripe and shadow of a selected row |
| `--ut-row-working-bg`, `-needs-bg`, `-ready-bg`, `-failed-bg` | Task rows and cards colored by state. Unset by default: each keeps its own surface |
| `--ut-needs-bg`, `-edge`, `-gap`, `-item-radius`, `-item-shadow`, `-divider`, `-fill-1/2/3`, `-act-bg`, `-act-fg`, `-act-border` | The «Te necesita» band: one tinted box by default; a style can make loose cards cycling through three fills. `theme-contrast.test.ts` measures the text on each fill |
| `--ut-row-gap`, `-inset`, `-radius`, `-side-radius`, `-bg`, `-side-bg`, `-border`, `-divider`, `-list-edge`, `-side-divider`, `-shadow` | Rows as loose cards: phone session and task rows (`.psr`, `.tsk`), sidebar rows (`.ut-side-row`) and desktop list rows (`.ut-srow`). `-divider` is the bottom edge of a phone row, so a card sets it to its `-border`. Neutral: today's list with hairlines. Optional `--ut-row-side-border` and `--ut-row-side-shadow` (fallbacks: `-border`, `-shadow`) let a style keep the sidebar rows flat while its phone rows are cards |
| `--ut-rows-inset`, `-radius`, `-bg`, `-shadow`, `-overflow`; `--ut-rows-side-inset`, `-radius`, `-bg` | One list as one rounded group: the phone list of a project (`.psr-list`) and the rows of a sidebar group (`.ut-side-rows`) become the card, with clear rows inside. Neutral: no card. With `-overflow: hidden` and `--ut-row-gap: -1px` the first row's rule is cut by the group's corners |
| `--ut-row-rule`, `-size`, `-position`, `-repeat`, `-first`; `--ut-row-side-rule`, `-size`, `-position` | A rule of the style's own between rows, painted as the row's `background-image` (so it can start where the text starts instead of spanning the row). Falls back to `--ut-grain`. `-first` is the value under an orchestrator's badge, where a rule would part the badge from its row |
| `--ut-group-gap`, `-bg`, `-outline`, `-edge`, `-overflow`, `-divider`, `-row-bg`, `-row-border`, `-row-radius`, `-row-shadow` | The same for the children of `.ut-group` (Settings). A shadow on a loose row needs `-overflow: visible` |
| `--ut-head-bg`, `-border`, `-radius`, `-shadow`, `-pad`, `-gap` | A project's header on the phone (`.prj-head`) as a strip of its own |
| `--ut-side-head-bg`, `-border`, `-h`, `-gap` | The same in the sidebar (`.ut-repo-head--compact`): an edge-to-edge band with rules above and below, its height and the room under it. Neutral: the plain 24 px line |
| `--ut-project-divider`, `-size`, `-air`, `-inset`, `-radius` | The fine line between one project and the next, on the phone list and in the sidebar: a `background` (color or gradient), its thickness (4 px at most), the air above it, its distance from the sides and the roundness of its ends. Each style draws its own (Dark Premium a brass fillet fading at the ends, Clay a groove, Cyber a phosphor rule with bright caps, Monocromo a silver fillet); never a gap alone or a band. `--audit-layout` fails without it. The header itself needs no token to fit: `project-group.ts` measures it and the name gets the room first (`data-squeeze`), in every style and type size; check it with `--views mobile-projects,mobile-projects-320,mobile-projects-440,desktop-projects`. |
| `--ut-fold-chevron`, `-summary`, `-needs` | A folded project (2026-11-10), on the phone list and in the sidebar: the ink of the chevron that folds it and opens it again (`.ut-fold-toggle`), of the one line a folded project shows instead of its rows (`.ut-fold-summary`, «1 te necesita · 3 sesiones · 2 en cola») and, in it, of what waits for the user (`.ut-fold-needs`). Optional and unset by default: they fall back to `--color-text-dim` and `--color-attention-text`, which every style and the paper scope already define, so no style has to set them. `.ut-fold-in` brings the rows back with a short motion (none with Reduce Motion). `--audit-layout` checks a folded project in `--views mobile-folded,mobile-folded-320,mobile-folded-440,desktop-folded`: no rows, a summary, and what waits for the user never cut. |
| `--ut-clip-action`, `--ut-clip-plate` | Bevels, optional and unset by default: `-action` is the `clip-path` of the buttons alone (`.ut-btn`, falling back to `--ut-clip-control`, `.ut-surface--action`, `--request-action`, `--segment`), `-plate` of the plates that open nothing (`.ut-surface--request`, `--notice`, `--record`, `--selected-row`). A key keeps its cut while focused (the style puts its ring inside); a selected row loses it, because its ring is outside. The stroke along a cut is a 45° gradient the effects layer paints in the corner, since the clip removes the border there |
| `--ut-clip-control`, `--ut-clip-card` | HUD corners: `clip-path` of `.ut-btn`, `.ut-chip`, `.ut-field`, `.ut-select` and of `.ut-card`. A focused piece has none, so the ring is whole; floating pieces never take it, because it would cut what they open |

Rules that keep it legible and fast:

- Nothing goes translucent over the terminal or a scrolling list: the terminal keeps `--ut-bg-app`, and the action bar, the phone's tab bar and the session's top bar use the solid `--ut-surface-1`.
- No `backdrop-filter` on rows or cards: over a smooth gradient it would look the same and cost a layer per row. Only floating pieces and the
  chrome that already had it blur.
- An element with content scrolling under it (sticky, fixed) needs `--ut-surface-1` or a blurred background of its own.
- Out of reach without changing structure, on purpose: a stroke along a cut corner (`clip-path` removes the border there, a diagonal border needs another element) and a style's own mascots (material tiles decorate backgrounds only; a stepped silhouette is hard-stop gradient rows).
- `@media (prefers-reduced-transparency: reduce)` turns off backdrop, translucency and blur; a browser without `backdrop-filter` gets solid
  floating pieces (end of `tokens.css`, `!important` because a style's selectors are more specific than `:root`).
- No animations: an effects layer accepts only borders, backgrounds, shadows and `color`, so a style cannot add motion.
- `theme-contrast.test.ts` measures a style with `--ut-backdrop` over every color of its gradient and over `--ut-bg-app` (`backdropStops`,
  `theme-tokens.ts`): each surface is composited over the stop and the page tint, so the worst point of the gradient is what must reach AA.

### Monocromo elegante: satin and engraved waves

The dark-only monochrome look follows Astra's ink/graphite/silver palette and density recipe.
Its static inline `--ut-waves` SVG is below 2 KB; no raster, network request or filter is needed.
`--ut-workspace-backdrop-position/repeat` and `--ut-sidebar-backdrop/size/position/repeat`
keep the waves on the workspace and sidebar, away from opaque cards and readable content.
Their fallbacks retain the existing grain and its placement for other looks.

A selected segmented control consumes `--ut-segment-selected-ink` in an unlayered rule scoped
to `html[data-look="monochrome-elegant"]`, including hover; other looks retain their cascade.
This keeps the text dark over silver without overriding other styles or states. Optional `--ut-toolbar-pad` and
`--ut-tabbar-pad-top/bottom` leave room for raised controls. Disabled icon buttons, switches
and menu items read the existing `--ut-disabled-opacity` (default still 0.4). Monochrome keeps
text opaque and adds a dashed inset outline to disabled buttons, menu items and switches;
disabled switches also use a muted fill and thumb while preserving their on/off position.

Full inventory, before/after alongside Astra's mockups and measured contrast:
[Monocromo elegante](verification/monochrome-elegant/README.md).

### Dark Premium: satin, brass and gold (2026-11-10)

Dark-only, own accent, Astra's recipe and density. Satin panels are a three-stop gradient, the main action a gold
gradient with dark ink, the selection a bronze surface with a gold mark. The grain and the header's arc of light are
static inline SVGs under 1 KB each (`--ut-grain-tile`, `--ut-arc`): no raster, request or filter. The arc is painted
only on `.ut-surface--bar` that is also `.ut-home-header` or `.ut-phone-header`.

`.ut-surface--request` is a new paint-only hook on each «Te necesita» row, neutral in every other look: a style
can make the request a card of its own material without touching `--ut-grain`, which also reaches bars and sidebar
rows. Control shadows stay within 2/4 px so they never leave the tab bar or the header (`--audit-layout`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Dark Premium](verification/dark-premium/README.md).

### Japandi: paper, oak and stone (2026-11-10)

Light-only, own accent, Astra's recipe and density (the sizes of Minimal claro, with material). The top rails
(`.ut-home-header`, `.ut-phone-header`, `.ut-sidebar-header`, the session headers) are oak with a horizontal
grain and a double joint; every other `.ut-surface--bar` is linen with a fine line. The work area is a sheet of
ivory paper painted with `--ut-workspace-backdrop` (fibers, the sheet and its 1 px edge as three layers; the inset
is `--ut-sheet-inset`, zero on a phone). The sidebar is sand linen with an 8 px oak post painted by
`--ut-sidebar-backdrop`. The grain, the post and the fibers are static inline SVGs under 1 KB each
(`--ut-wood`, `--ut-wood-post`, `--ut-paper`), as the recipe asks: no raster, request or filter.

Optional `--ut-side-row-inset` (fallback 4 px, the old literal) is the side margin of a sidebar row, so a
selected row does not cover the post. Requests and the shield notice keep ceramic actions (paper with a solid
edge); walnut is for the one main action. Selection is sand plus a walnut rule (rows) or underline (controls).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Japandi](verification/japandi/README.md).

### Nature: paper and landscape (2026-11-10)

Light-only, own accent, Astra's recipe and density (the sizes of Dark Premium, in paper). The app's top bars
(`.ut-home-header`, `.ut-phone-header`, `.ut-sidebar-header`) are cream paper with four overlapping sage hills at
their right (`--ut-hills`, a static inline SVG under 1 KB), cut by the bar's lower edge the way the sheets cut them
in the mockup. The work area is a sheet of thick paper with 30 px corners painted by `--ut-workspace-backdrop`
(the tile, two radial corners, the top strip and the body; `--ut-sheet-inset/-top/-r` are zero on a phone, which
gets the paper edge to edge). The sidebar is the same paper with pale hills in the room its rows leave at the
bottom (`--ut-hills-pale`, light enough for muted text to keep AA over it).

The paper is one 256 px raster tile (`assets/looks/nature/nature-papel.webp`, about 36 KB, generated from the
recipe's noise plus long fibers; `look-assets.test.ts` holds every look tile under 60 KB and checks that every
`/looks/<id>/<file>` a sheet names exists). It is a background of the page, the sheets and floating pieces, never
under the record, a field or a request. Requests are loose sage cards cycling through three fills, moss capsules
are the main actions, the failure notice is pale clay paper with a mark painted as a background (so it stays
straight beside 30 px corners). Between projects: a fine stem that fades at both ends with a moss bud in the
middle (`--ut-project-divider`). Sidebar rows stay flat (`--ut-row-side-border/-shadow`); only the selected one
is a sage leaf with a darker edge.

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Nature](verification/nature/README.md).

### Material You: tonal surfaces and grouped rows (2026-11-10)

Light-only, own accent, Astra's recipe and density. No texture on purpose (the recipe sets it to none): identity is
composition. The work area is a raised sheet with 36 px corners painted by `--ut-workspace-backdrop` in one flat
color; bars and containers are tonal lavender with no line or shadow. Requests are one group: rows 4 px apart,
straight inside, 28 px at the group's outer corners (`.ut-surface--request:first-child/:last-child` in the effects
layer), rose with every third in lavender; `.ut-group` follows the same rule through `--ut-group-gap`. Four button
ranks: filled violet (`.ut-btn--primary`, and a request's action when its `data-action` is answer, confirm or
merge), tonal (`.ut-surface--action`), outlined (`.ut-btn--secondary`, `--ut-outline`, 3.5:1) and text. Hover and
press are flat state layers (`--ut-state-hover/-press`), with no movement.

Optional `--ut-segment-outline` (a `box-shadow`) and `--ut-segment-check` (an image as `content`) outline the
Claude/Codex picker and mark the chosen agent with more than its fill; neutral elsewhere. `--ut-border-strong` stays
soft because the app also draws hairlines with it; controls take the firm `--ut-outline`. Between projects: a 1 px
line that starts in a short violet capsule (`--ut-project-divider`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Material You](verification/material-you/README.md).

### iOS Nativo: grouped lists (2026-11-10)

Light and dark, own accent, Astra's recipe and density. No texture on purpose (the recipe sets it to none):
identity is structure. The list and the sidebar are the system grey (`--ut-workspace-backdrop`,
`--ut-sidebar-backdrop`, one flat color each); what they hold is white groups with 18 px corners and no edge.
«Te necesita» is a large title (`--ut-needs-label-size/-weight/-tracking/-case`, neutral elsewhere: the small
uppercase label) over one group of 104 px rows; each project's rows on the phone and in the sidebar are one group
too (`--ut-rows-*`, with `.ut-side-rows` wrapping a sidebar group's rows). Separators start where the text starts:
`--ut-row-rule` on list rows, a background on `.ut-surface--request`, a `border-image` on `.ut-row`. Three action
ranks: filled blue (`.ut-btn--primary`, `.ut-surface--primary`), tinted (`--ut-tint`, every secondary action and a
request's button) and text. A sheet's Cancel is a white plate of its own (`.ut-surface--floating` on a button) and
its options are blue (`--ut-sheet-action-ink`). `--ut-r-pill` is 12 px, so buttons are rounded rectangles while
badges and switches (under 24 px tall) stay capsules. Between projects: a hairline with the sheet grabber in its
middle (`--ut-project-divider`). `--ut-task-title-weight/-tracking` make a task's title a large title.

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[iOS Nativo](verification/ios-native/README.md).

### Editorial: ivory cards on warm black, and the paper scope (2026-11-10)

Dark only, own accent, Astra's recipe and density. A mixed composition, not an inversion: the ground, the bars
and the terminal are warm black with cream ink (the style's ordinary tokens, the mode it forces), while requests,
cards, a project's rows on the phone, the sidebar, the composer, notices, Settings groups, sheets, dialogs, menus
and toasts are paper with dark ink. The masthead carries a double fillet (`--ut-bar-relief`), every card the 3 px
thickness of its paper (`--ut-paper-edge`), the record a heavy black rule on top. Georgia for «Te necesita», the
request and card titles, the task title and the composer; rectangular 4 px controls of 44 px; one orange main
action. The grain is the recipe's static inline SVG tile (`--ut-texture`, under 1 KB), on sheets and the sidebar
only. Between projects: an Oxford rule, 2 px over a hairline (`--ut-project-divider`).

**The paper scope** is what makes two palettes possible without touching a component. The style's file defines
`--ut-paper-*` next to its dark palette; one rule in `tokens.css`, `[data-look="editorial"] :where(<pieces>)`,
gives those pieces the paper values under the generic names (`--ut-text: var(--ut-paper-text)` …) and evaluates
again every token and alias of the first block that depends on them (`--color-*`, `--text-color-*`, `--shadow-e*`,
tints, avatar tiles), because a `var()` is resolved where it is declared. Everything inside a paper piece then
reads paper values without knowing; a piece that is not listed keeps the dark palette and stays legible. Rules:

- A token of the style's file that a paper piece reads (`--ut-needs-act-bg`, `--ut-row-divider`, `--ut-composer-bg`…)
  names `--ut-paper-*` itself: it is resolved on `<html>`, where the generic palette is the dark one.
- The effects layer reads the generic tokens only, so one rule paints a button on the ground and on paper.
- Never remapped: the terminal, logos, `--ut-float-*`, `--ut-session-bar`. `--ut-bg-app` inside a paper piece is
  paper, so a well inside a card is not a black hole.
- `theme-contrast.test.ts` measures every pair with the paper palette too (and the fills the style names with
  `--ut-paper-*`), checks that each remapped token has its `--ut-paper-*` value, and fails when a token of the first
  block that depends on a remapped one is missing from the scope (unless the style sets it itself).

Optional `--ut-needs-label-font`, `--ut-needs-title-font`, `--ut-card-title-font/-weight`, `--ut-composer-font` and
`--ut-task-card-shadow` are neutral elsewhere (the UI font, the semibold weight, the row's own shadow).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Editorial](verification/editorial/README.md).

### Cómic: ink panels, drawn corners and print shadows (2026-11-10)

Light only, own accent, Astra's recipe and density. Tan paper table (`--ut-workspace-backdrop`, one flat color)
under cream panels with a 3 px blue-black ink frame, uneven elliptical corners (`--ut-wobble-card/-alt/-ctl/-bubble`,
read as `border-radius` by the effects layer and by the radius tokens that take a full value) and a solid offset
shadow with no blur. Requests are loose 104 px panels with halftone only in their two margins (`--ut-dots-start/-end`,
two fading 7 px tiles repeated down each side, so no mask is needed and no dot sits under a letter); every second
panel is drawn with other corners. The main action is orange with ink lettering; selection is orange plus outline
plus shadow. The record is flat blue paper, failures and the shield notice flat peach. Section titles («Te necesita»,
the phone eyebrows) and the task title lean in Trebuchet bold italic; body text stays upright. Everything is a static
inline SVG of a few hundred bytes: no raster, request or filter, as the recipe asks.

Optional hooks, neutral elsewhere: `--ut-needs-label-style`, `--ut-task-title-font/-style`,
`--ut-eyebrow-font/-style/-weight/-size/-line/-ink` (the phone's section eyebrows), `--ut-composer-radius`,
`--ut-composer-gap`, `--ut-composer-position` and `--ut-composer-tail` (`""` draws the speech bubble's tail under the «what to do» box: a
decoration with no hit area in the box's own paper and ink). Between projects: one brush stroke of ink that swells
from a fine point and ends in five shrinking halftone dots (`--ut-project-divider`, 4 px).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Cómic](verification/comic/README.md).

### Minimal Pro: ink hierarchy on pure white (2026-11-10)

Light only, own accent, Astra's recipe and density (the same scale tokens as Minimal claro). No material at all, as the
recipe asks: white surfaces, 1 px rules, no shadow, gradient, blur or texture. The character is type and ink: «Te
necesita» as a 32 px semibold heading, 22 px semibold request titles in 102 px rows, a task title up to 44 px, black
main actions and black indicators, 6 px outlined controls of 44 px. Burnt orange `#943B00` only says «permission» and
«failed». Selection is grey with a 3 px ink rule; disabled is grey ground and dimmer ink, never opacity. Between
projects: a hairline that opens with a 32 × 3 px ink bar (`--ut-project-divider`).

Optional hooks, neutral elsewhere: `--ut-needs-answer-ink` (the line of a request that waits for an answer or an OK;
the item carries `data-action`) and `--ut-task-danger-ink` (a task's destructive action, the error text by default).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Minimal Pro](verification/minimal-pro/README.md).

### Glassmorphism: smoked glass over amber light (2026-11-10)

Dark only, own accent, Astra's recipe and density (the scale of Dark Premium with 24 px panes and 15 px controls).
`--ut-backdrop` is three fixed radial halos (two amber, one plum) on graphite; `--ut-page-alpha` is 0 % and
`--ut-surface-alpha` 66 %, so the same halo reads through several panes. Rows, cards and requests are translucent
with no `backdrop-filter`; the bars and the floating pieces ask for it, and stay at 92–97 % because the blur does
not show in the twin's captures in either engine (cause not found): they must read without it. A pane is a
translucent fill (`--ut-glass-1/-2/-dense/-control/-float/-amber`, each a `color-mix` with the alpha token, so less
transparency makes them solid), a painted reflection (`--ut-streaks`, `--ut-reflection`), an edge of light and a
deep shadow (`--ut-elev-*`). The frost is one 128 px raster tile (`assets/looks/glassmorphism/glass-escarcha.webp`,
about 9 KB) through `--ut-grain`, never under the record or a field. The halos are darker than the mockup's so text
straight on the page keeps AA at their brightest point. Between projects: the bevelled edge of a pane seen from the
side, a pixel of light over one of shade with an amber glint (`--ut-project-divider`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Glassmorphism](verification/glassmorphism/README.md).

### Holográfico / Glass: milky glass over blue, pink and green light (2026-11-10)

Light only, own accent, Astra's recipe and density (92 px requests, 22 px row titles, 44 px actions, 28 px panes,
20 px rows, 14 px controls; type and action padding are `clamp()`s so a phone keeps its titles). `--ut-backdrop` is
the recipe's 135° gradient (`#9FCAF3 → #C3D6FB → #F3BDDD → #A9E4D5`) under two white veils and one inline SVG with
two optical streaks (under 1 KB, no raster tile); `--ut-page-alpha` is 30 % and `--ut-surface-alpha` 72 %, so the
same light reads through every pane. A pane is a translucent fill (`--ut-glass-1/-2/-dense/-control/-float`, each a
`color-mix` with the alpha token, so less transparency makes them solid), a white reflection plus a faint spectrum
(`--ut-reflection`, `--ut-iris`), a white border and the iridescent rim: four one-pixel inset shadows, white above,
cyan left, pink below and mint right, with a soft glow of the same colors inside (`--ut-rim`, `--ut-rim-glow`,
carried by `--ut-elev-*`). A gradient border would need a masked pseudo-element, which the effects layer may not
add. Every button is holographic glass with dark ink and a slate outline (`--ut-holo-button`; the main action is the
more saturated `--ut-holo-main` with the accent's outline), never white text on it. Selection is never color alone:
a lit pane with a 3 px blue rule on rows, a straight 2 px underline on tabs, segments and toggles. Rows and cards
carry no `backdrop-filter`; bars and floating pieces ask for it and stay at 94–98 % because the blur does not show
in the twin's captures. Between projects: a hair of spectrum over a pixel of white, fading at both ends
(`--ut-project-divider`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Holográfico](verification/holographic/README.md).

### Aurora / Gradiente: violet glass over one continuous aurora (2026-11-10)

Dark only, own accent, Astra's recipe and density (98 px requests, 24 px request titles, 48 px capsule actions,
72 px sidebar rows, 24 px panes, 17–22 px rows; request titles and action type are `clamp()`s so a phone keeps its
titles). `--ut-backdrop` is the recipe's four fields of light (a violet field, magenta at the right, orange in the
top right corner and the bottom left edge) under a lit curve (one ellipse with a bright rim) and a film grain, one
128 px raster tile (`assets/looks/aurora/aurora-grano.webp`, about 10 KB) on the backdrop only, never over a pane
or text. `--ut-page-alpha` is 60 %: the recipe's dark veil, and the least that keeps text straight on the page at
AA over the orange corner; `--ut-surface-alpha` is 82 %. A pane is a translucent violet fill
(`--ut-glass-1/-2/-dense/-float`, each a `color-mix` with the alpha token, so less transparency makes them solid),
the sky's tint from violet to magenta (`--ut-sky-tint`, also `--ut-grain` for rows), a reflection from above
(`--ut-reflection`), a lavender border and a diffuse shadow (`--ut-elev-*`). Controls are capsules (`--ut-r-pill`
on `.ut-btn` and `.ut-chip` from the effects layer; fields keep 16 px), the main action is dawn (`--ut-dawn`,
peach to pink with aubergine ink), the selection is lit violet glass with a lavender outline and a warm 3 px bar
(`--ut-lit`), and the record is a dark cavity with no aurora under its lines. Bars carry the sky's three colors
(`--ut-bar-fill`). Floating pieces are solid (`--ut-panel-alpha` 100 %) because the blur does not show in the
twin's captures and the list read through a sheet. Between projects: a ribbon of the aurora seen edge on, one
hair from violet through magenta to dawn inside a faint halo, fading at both ends (`--ut-project-divider`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Aurora](verification/aurora/README.md).

### Neumórfico / Frosted: one pearl surface, raised and dug (2026-11-10)

Light only, own accent, Astra's recipe and density (104 px requests with 26 px corners, 23 px request titles, 48 px
actions with 16 px corners, 68 px sidebar rows, 76 px headers, a task title up to 40 px; request titles and action
type are `clamp()`s so a phone keeps its titles). Everything is the page's own color (`--ut-surface-1` equals
`--ut-bg-app`, every alpha 100 %, no blur): what tells a piece from the page is its pair of shadows, white up and
left and blue-grey down and right (`--ut-shade`, `--ut-light`; 10/22 px on requests, 6/14 px on rows and cards,
4/8 px on buttons so a relief never leaves its bar, sheet or the screen), an edge of light and a diagonal sheen
(`--ut-sheen`). What is selected, typed or read is dug in instead: the selected row, tab and toggle are a lavender
cavity with a lavender outline and violet ink (`--ut-sunken`), fields and the «what to do» box are cavities with a
slate outline (`--ut-field-relief`, `--ut-well-relief`), and so is the record. The one main action is peach with
brown ink (`--ut-peach`); violet `#514292` is ink and selection, never a slab on a shared piece. Every control
keeps a solid slate outline (`--ut-border-strong`, 3:1), so shadows are never its only limit. Floating pieces are
solid pearl with one deep dark shadow and no white one: over a scrim it would be a halo. The satin finish is one
128 px seamless raster tile (`assets/looks/neumorphic/neumorphic-satin.webp`, about 6.5 KB, generated noise at
1.6 % mean alpha) through `--ut-grain` and the panes' second background layer, never under the record, a field or
the «what to do» box. Between projects: a channel scored into the surface, a pixel of shade over a pixel of
light, fading at both ends, with a lavender inlay at its middle (`--ut-project-divider`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Neumórfico](verification/neumorphic/README.md).

### Skeuomórfico moderno: brushed chassis, bevelled plates, raised keys (2026-11-10)

Dark only, own accent, Astra's recipe and density (108 px requests with 12 px corners, 24 px request titles, 48 px
keys with 9 px corners, 72 px sidebar rows, 78 px headers, a task title up to 40 px; request titles and action type
are `clamp()`s so a phone keeps its titles). The chassis (page, bars, sidebar) is brushed aluminium: one seamless
raster tile of horizontal hairlines (`--ut-brushed`, `assets/looks/skeuomorphic/skeuo-cepillado.webp`, 256 × 128 px)
over a 110° gradient. A plate is a two-tone face parted by a gloss line at 48 %/51 % (`--ut-face`) under a moulded
grain (`--ut-polymer`, `skeuo-polimero.webp`), with a black cut all round (`--ut-cut`), its upper edge lit
(`--ut-bevel`) and a contact shadow (`--ut-raised`). Keys are the same recipe, darker (`--ut-key`), with lettering
pressed in (`text-shadow`); the one main key is orange with dark ink (`--ut-orange`), its shadow short enough to stay
inside a sheet. What is selected, typed or read is sunk in (`--ut-sunken`): the selected row is a warm cavity with a
3 px orange index mark, the chosen tab the same with the mark below, fields and the «what to do» box are cavities,
and the chosen segment is the one raised key in its rail. The record is a near-black screen with nothing under its
lines, inside a frame of four bevels painted with inset shadows (`--ut-record-relief`), so no border moves the
layout. Every alpha is 100 % and nothing blurs. Between projects: a slot milled into the chassis, two pixels of
black over a lip of light fading to the right, starting at an orange index mark (`--ut-project-divider`).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Skeuomórfico moderno](verification/skeuomorphic/README.md).

### Cyberpunk: bevelled plates, magenta and cyan fillets (2026-11-10)

Dark only, own accent, Astra's recipe and density (104 px requests, 24 px request titles, 48 px keys, 76 px sidebar
rows, 84 px headers, a task title up to 40 px; request titles and action type are `clamp()`s so a phone keeps its
titles). An indigo night (`#080619`, which is also `--ut-surface-1`: the lists are the page) under opaque plates of
violet black (`--ut-plate`, a 105° gradient). The signature is the bevel, top right and bottom left: a real
`clip-path` on keys (`--ut-clip-action`, 9 px), on requests, the shield notice, the record and the selected row
(`--ut-clip-plate`, 13 px) and on `.ut-card` (`--ut-clip-card`), with the stroke along each cut painted as a 45°
gradient in the corner (`--ut-chamfer` and its magenta, cyan, rose and danger variants; the band is centred on the
diagonal, so one image serves both corners). The «what to do» box opens menus, so it is not clipped: its bevels are
painted (a corner in the page's color under the cyan stroke, `--ut-well-corner-top/-bottom`) and its frame is four
edges that stop at them. Magenta says what acts and what is selected (the main action with dark ink, the 48 × 3 px
tab that opens every plate, the selected row's frame and rail, the top bars' upper line); cyan says what is read or
typed (the record's rail and frame, the composer, the focus ring, the bracket in every key's lower right corner, the
stretch that ends a top bar and a floating piece). Every third request reads cold: a cyan tab and rail. Monospace
only for «Te necesita», the phone's eyebrows and the record. Circuit traces are the recipe's inline SVG tile
(`--ut-traces`, 180 × 120, under 1 KB) on the sidebar, and fainter on the lists (`--ut-traces-faint`); 4 px scanlines
only under the record. No raster, no glow on letters, no animation; every alpha is 100 % and nothing blurs. Between
projects: a circuit trace, a magenta lead on the upper line, a 45° step down and a violet run that fades along the
lower line (`--ut-project-divider`, 4 px).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Cyberpunk](verification/cyberpunk/README.md).

### Neón futurista: graphite HUD, bevelled glass, rails of orange light (2026-11-10)

Dark only, own accent, Astra's recipe and density (104 px requests, 24 px request titles, 48 px keys, 76 px sidebar
rows, 84 px headers, a task title up to 40 px; request titles and action type are `clamp()`s so a phone keeps its
titles). Near-black graphite (`#090A0C`, also `--ut-surface-1`: the lists are the page) under opaque plates of dark
glass (`--ut-plate`, a 110° gradient). It shares Cyberpunk's bevel pieces (`--ut-clip-action` 10 px,
`--ut-clip-plate` and `--ut-clip-card` 18 px, top right and bottom left, the stroke along each cut painted as a 45°
gradient: `--ut-chamfer` and its key, hot, cold, rose and danger variants) and adds its own signature, the light on
the edges: every plate opens with an orange tab on its upper edge (`--ut-tab-hot`, amber to orange) and closes in
its lower right corner with a rail that fades in (`--ut-rail`) and a 45° tick (`--ut-tick-hot`, the opposite
diagonal of the chamfer); every key ends in a 1 px amber bracket. Orange says what acts and what is selected (the
main action, a vertical gradient with dark ink and a paler lip; the selected row's frame, rail and tick; «Te
necesita»); amber says what is read or typed (the record's rail, the composer's frame, the focus ring, the rail that
ends a top bar over its own light, `--ut-rail-glow`). No magenta, no cyan, no card filled with orange. The «what to
do» box opens menus, so its bevels are painted in the page's color (`--ut-well-corner-top/-bottom`). Monospace only
for «Te necesita», the phone's eyebrows and the record. Circuit traces are one inline SVG tile (`--ut-traces`,
240 × 160, under 1 KB, closing on its own height so it repeats without a seam) on the sidebar, and fainter on the
lists (`--ut-traces-faint`); 4 px scanlines only under the record. No raster, no glow on letters, no animation;
every alpha is 100 % and nothing blurs. Between projects: a rail of light, a 56 × 2 px amber lead over a breath of
orange, the frame's bronze cooling along the lower line and the plates' tick rising at the far end
(`--ut-project-divider`, 4 px).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Neón futurista](verification/neon-futuristic/README.md).

### Aero / Vision-like: sky-blue glass, lens buttons, a white lip (2026-11-10)

Light only (it used to force dark with white type; Astra's recipe is dark blue ink on pale glass), own accent,
Astra's recipe and density (108 px requests with 28 px corners, request titles up to 25 px, 48 px capsule actions,
72 px sidebar rows, 80 px headers, a task title up to 42 px; request titles and action type are `clamp()`s so a phone
keeps its titles). `--ut-backdrop` is the recipe's 128° blue under two veils of light and two large elliptical
sheets of glass with a white rim (`--ut-sheets`, one inline SVG under 1 KB; no raster tile, as the recipe asks). The
blue is lighter than the mockup's corners (`#86BBE7` at its darkest, not `#5C9BD4`) so muted text straight on the
page keeps AA. `--ut-surface-alpha` is 40 %: the lists are a thin veil over the sky, and the panes add 38 points of
their own (`--ut-glass-1/-2/-dense`, each a `color-mix` capped with `min(100%, …)`, so less transparency makes them
solid), which is what parts a white pane from the blue ground. A pane carries a diagonal reflection
(`--ut-reflection`), a white border, a white upper lip and a blue lower one (`--ut-rim`) and a soft separating
shadow (`--ut-pane-shadow`). Every button is a lens: a capsule with a white reflection above and a blue base
(`--ut-lens`), dark ink and a solid blue outline; the main action parts its reflection in two with a line
(`--ut-lens-main`, the recipe's 49 %/51 % stops). The agent picker and every `.ut-segmented` is a sunken blue rail
with the chosen segment raised in white glass; the selected row is a pale blue lens with a solid edge and a 4 px
side mark (`--ut-lens-lit`, `--ut-row-selected-shadow`). Fields are more opaque glass with an inner shadow, the
record almost opaque milk with an inner shadow, the failure the same pane with a garnet mark painted as a background (so
it stays straight beside 28 px corners). Top bars carry an arc of light (`--ut-arc`). Rows and cards carry no
`backdrop-filter`; bars and floating pieces ask for it and stay at 90–97 % because the blur does not show in the
twin's captures. Between projects: the edge of a pane seen from the side, a hair of white over a hair of blue
fading at both ends, with one 40 px drop of deep blue at its middle (`--ut-project-divider`, 3 px).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Aero](verification/aero/README.md).

### Retro Pixel: sky, stepped ink frames, cartridge-green keys (2026-11-10)

Light only, own accent, Astra's recipe and density (106 px requests, 44 px keys with 17 px bold type, 76 px sidebar
rows, an 88 px home header, a task title up to 36 px; request titles, actions, the record and the composer are
`clamp()`s so a phone keeps its titles in a monospace). The pixel is in the geometry, never in the letters: every
radius is 0 and a frame is **a cross of four hard shadows outside the piece** (`--ut-pixel-frame`, 4 px, and
`-frame-sm`, 3 px), so each corner is a missing square, over a shadow that steps down and right
(`--ut-pixel-panel`, `--ut-pixel-row`). No `clip-path`: a focus ring stays whole, 3 px of ink 5 px away. A key adds
a light lip above and a darker edge inside (`--ut-pixel-lip`, `--ut-pixel-key`), goes cartridge yellow under the
pointer and loses its shadow when pressed. Pieces a container would cut (Settings groups, the failure sheet, chips,
tags, the tab bar) keep their frame inside: a real border or an inset ring. Panels keep a 3 px transparent border, so
their content stands off the frame exactly as with a drawn one.

The sky is `--ut-backdrop` (a blue gradient and two pixel clouds), repeated on the lists as `--ut-workspace-backdrop`
with the ground running along their foot and the stepped hills standing on it at the right; `--ut-page-alpha` is 0 %
and every panel is opaque. The sidebar is flat pale sky: its rows would slice a landscape. Requests carry dither
fading in from their left margin only (`--ut-pixel-dither`); the third fill is the recipe's ready green. Everything
drawn is a static inline SVG with `shape-rendering='crispEdges'` (`--ut-pixel-ground`, `-hills`, `-cloud`, `-dither`,
`-zig`, 150–590 bytes each): no raster, no request, no downloaded font, as the recipe asks. Between projects: a 2 px
ink line that steps up and down every 8 px (`--ut-project-divider`, 4 px tall); the project header carries no band.

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Retro Pixel](verification/retro-pixel/README.md).

### Neobrutalismo: yellow bands, 3 px black frames, hard shadows (2026-11-10)

Light only, own accent, Astra's recipe and density. Warm grey table `#F4F1E7` with the recipe's one texture, a 24 px
vector grid (`--ut-grid`, an inline SVG read by `--ut-workspace-backdrop`; never under a field, the record or the
sidebar), under warm white plates with a 3 px black frame, 4 px corners and a solid shadow at 45° with no blur
(6 px on plates, 4 px on controls and rows). The top bars are flat yellow `#FFE500` closed by a 4 px black rule; the
lesser bars are white with a 3 px one. A project's header is a yellow band: a plate on the phone (`--ut-head-*`) and
an edge-to-edge band with 3 px rules in the sidebar (`--ut-side-head-bg/-border/-h/-gap`, neutral elsewhere: the
plain 24 px line). Selection is a yellow plate plus outline plus shadow; the agent picker of the «what to do» box
inverts to white on black (`--ut-invert-*`). Orange is kept for the shield notice and coral for failure, each also
said in words. The record is white under a black head strip. Settings rows are loose plates (`--ut-group-*`), not
one framed group. System type at 650 to 900. No raster, gradient on a piece, blur or filter.

Between projects: a cut mark, one 28 px block of ink followed by a rule of hard dashes, 2 px (`--ut-project-divider`,
two gradients).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Neobrutalismo](verification/neobrutalism/README.md).

### Cosmos / Espacial: an observatory at night (2026-11-10)

Dark only, own accent, Astra's recipe and density (109 px requests with 18 px corners, request titles up to 25 px,
48 px capsule actions, 70 px sidebar rows, 76 px headers, a task title up to 42 px, the record at 20 px; request
titles and action type are `clamp()`s so a phone keeps its titles). Blue that is almost black (`#080A21`; the lists
are the page, so `--ut-surface-1` is nearly the same night) under opaque panels: the recipe's 112° gradient
(`--ut-panel`, `#272446 → #151831`), a one-pixel lavender border, an edge of light and a deep shadow. Every alpha is
100 % and nothing blurs: text never floats on a nebula. Requests are loose cards cycling lavender, blue and rose
(`--ut-panel`, `-blue`, `-rose`), each with a 2 px mark of its color on the leading edge. Controls are capsules; the
one main action is lavender with dark ink (`--ut-main`), the selection a lit panel with a lavender outline and a
3 px mark (`--ut-lit`), fields and the agent picker dark cavities, the record a blue-black cavity, the failure a
plum panel with a rose mark. Focus is the recipe's cyan ring.

The sky is three things, all static: a tile of small stars (`--ut-stars`, the recipe's inline SVG, 397 × 293 so its
repeat never lines up with a row), two faint nebulae, and on the lists a planet in the top right corner
(`--ut-workspace-backdrop`): a disc of radial gradient with a bright limb, the same disc in the page's color moved
up and right as its terminator, a halo and one orbit (`--ut-orbit`, an inline SVG ellipse). Its radius is
`--ut-planet-r` (`clamp(120px, 38vw, 330px)`), chosen so that at every width «Solo esto» falls on the dark disc and
the limb crosses the head between the label and that button; «Solo esto» also carries the recipe's opaque capsule
(`--ut-needs-toggle-bg/-edge/-pad/-radius/-pressed-bg`, neutral elsewhere: the plain text button). The planet is not
part of `--ut-backdrop`, so `theme-contrast.test.ts` does not measure text over its limb: the geometry above is what
keeps text off it. The sidebar has a smaller orbit at its foot (`--ut-orbit-small`). No raster, filter or animation.
Between projects: an orbit seen edge on, a hair of lavender that fades at both ends with one small bright moon on
it (`--ut-project-divider`, 3 px).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Cosmos](verification/cosmos/README.md).

### Playful / 3D: toy plastic, puffed cards, keys on a base (2026-11-10)

Light only, own accent, Astra's recipe and density (102 px requests with 30 px corners, request titles up to 23 px
at weight 800, 48 px actions with 22 px corners, 72 px sidebar rows with 25 px corners, 82 px headers, a task title
up to 40 px, the record at 20 px; request titles and action type are `clamp()`s so a phone keeps its titles).
Rounded system type (`ui-rounded`), nothing downloaded. Every alpha is 100 % and nothing blurs. What makes a piece
read as plastic is the same four layers everywhere: a white lip above, a tinted shade under the face, a **hard base
of the piece's own color** a few pixels below it (6 px cream under shells, 5 px under requests and phone rows, 4 px
lilac under keys, deep violet under the main action) and a soft contact shadow. Requests are loose cards cycling
lavender, coral and yellow (`--ut-lavender`, `-coral`, `-yellow`, each with its base in
`--ut-needs-item-shadow[-coral|-yellow]`). Keys are white going lilac with a solid edge (`--ut-key`); the one main
action is violet with white type (`--ut-main`); discarding is the same key in pale coral with dark red type. The
selection is a raised lavender piece with a solid 2 px edge and darker type (`--ut-lit`), the current tab the
mockup's yellow key (`--ut-tab-key`, `--ut-tab-selected-*`; the effects layer paints
`.ut-surface--control[aria-selected="true"]` with it). Fields, the agent rail, the «what to do» box and the record
are cavities (`--ut-inset-fill`, `--ut-field-relief`); the record sits in a thick lavender frame painted as an
inset ring, so it takes no room. The failure is a coral block on its base. Controls embedded in a bar, chips and
selects keep their base **inside** the piece (`--ut-control-relief-small`, an inset 3 px foot) and the main action's
contact shadow is 7 px at most, so no relief leaves its bar, sheet or the screen (`--audit-layout`).
`--ut-piece-raised` (chat bubbles and other shadow-root pieces) uses a translucent base, right on any fill.

No raster: the recipe keeps every face smooth. The only tile is its confetti (`--ut-confetti`, an inline 96 px SVG
with one dot and one dash at 18 %), behind the lists only. Between projects: three toy beads on a thread, a hair of
lilac with a lit underside that fades at both ends and a coral, a yellow and a mint bead at its middle
(`--ut-project-divider`, 4 px).

Before/after next to Astra's mockups, coverage and what CSS does not reach:
[Playful / 3D](verification/playful-3d/README.md).

### Material surfaces

`ut-surface--material` is the shared hook for real raster material. Its geometry in `styles/material.css` is
explicitly scoped to `html[data-look="clay"]`, including positioning and isolation, so the class
cannot override another look's sticky/fixed/absolute elements. Its empty `::after` sits behind
content, with `pointer-events: none`; `--ut-material-content` defaults to no pseudo-element and
`--ut-material-isolation` to `auto`. Only that empty layer takes `--ut-material-opacity` and
`--ut-material-clip`. The effect sheet sets its background, background blending and inset rim
with the host's inherited radius; no filter, opacity or blending reaches text, project logos,
avatars or 3D icons.
`--bar`, `--action`, `--primary`, `--well`, `--record`, `--detail` and the state modifiers are
surface variants. These hooks are neutral outside Clay.

Clay's source tiles are in `src/client/assets/looks/clay/` (Astra's supplied assets, copied unchanged).
`copy-assets.js` cleans/generated sheets **before** copying assets, so both survive in `public/looks/`.
Use absolute `/looks/<id>/<file>.webp|png` URLs from the concatenated CSS, with no query: the build
adds each image's version (`?v=<hash of its content>`, `copy-assets.js`), and the page asks for each
sheet by its own (`lookHref`, from the versions the server writes into `index.html`). The service
worker caches a versioned sheet or image for good on first use, so a changed one is another URL and
shows on the first load after the change; no unused style's images are precached. Keep each tile below 60,000 bytes. `look-assets.test.ts` checks two builds,
identical bytes, the complete concatenated stylesheet, referenced files and sizes. The unused
nine-slice rim remains a supplied asset, but the stylesheet does not need to reference every
asset. `sw-shell.test.ts` checks offline serving and revalidation.

Clay retains the standalone list header's 40 px scroll-edge clearance whenever a top safe area
is present. Its solid status band matches the header. `--ut-header-blur` and `--ut-toolbar-blur`
are `none`; the header's material rim uses crisp insets instead of the diffuse nine-slice tile.

```bash
node web/scripts/ui-shots.mjs --look clay --views mobile,desktop-home --measure-scroll --audit-layout --out /tmp/clay-audit
```

The optional `--measure-scroll` records three 180-frame sweeps (p50/p95/max and frames above 25 ms),
from the actual list at device scale 2. These are host-browser measurements, not real-phone FPS.
`desktop-home`, `task-desktop` and `mobile-rows` are optional comparison views. Clay's own one-off audit
(`--audit-clay`: painted texture against the text colors, HTTP bytes and MIME types, the service worker
offline, Chromium's emulated 59 px top safe area) was run for this work and removed on 2026-11-11 with the
other per-style audits; `--audit-layout` is the audit every look shares.

The desktop home has its own audited views (2026-11-11): `desktop-home-1600` and `desktop-home-1280` (the
projects' grid, with projects of one, two and more columns) and `desktop-home-sections` (the folding sections
under it). There the audit fails on `project-header-wider-than-cards` (a project's header ends where its widest
row of cards ends: no empty column inside a row), `project-name-cut-with-room` / `project-name-cut-beside-labels`
(the grid's header, like the phone's, gives its room to the name first: `data-squeeze` 0-3 on `.ut-repo-head--fit`,
measured by `repository-header.ts`) and `section-headers-differ` / `section-chevron-off-its-line` (every folding
section of the home wears `renderSectionHead()`: `.ut-section-head` with its `.ut-section-toggle`).

### Modes and accent

| Registry | Effect |
| --- | --- |
| `modes: 'dark'` or `'light'` | That mode is forced while the style is on. The mode control shows disabled with the explanation; the saved light/dark/system choice is untouched and comes back with another style. |
| `modes: 'both'` | Light, dark and system work as always. |
| `fixedAccent: true` | The style's values win over `data-accent`; the swatches show disabled with a note, and the user's accent comes back with another style. |
| `fixedAccent: false` | The user's accent is applied. |

The state colors (`success`, `warning`, `danger`, `info` and `-text`) stay legible: each style goes through
`theme-contrast.test.ts` in its modes. Choosing: device (`localStorage` `untether-look`), then the server's `look`, then Original.
Picking Original is a choice of its own.

### Server default

`"look": "<id>"` in `~/.untether/config.json` sets a default for every client without a choice of its own (opt-in, off by
default). A value that is not a registered id is dropped. The server writes it into `index.html`, so a new device has the style
from its first frame. Settings → Appearance says when there is a server default and
offers going back to it.

### Before the first paint

`assets/theme-init.js` and its inline copy in `index.html` read the id, the forced mode and the backgrounds from the stored
entry `untether-look-boot` (a device with its own choice) or from `<meta name="ut-server-look">` (one without), so the first frame has the right attribute, mode, background and `theme-color`. The app stays
behind the boot screen until `styles.css` and the style's sheet are in. `<html>`'s background and `<meta name="theme-color">`
then follow the real `--color-bg` (`syncThemeColorMeta`). A sheet that cannot be loaded changes nothing: its style and mode
are not applied, the failed link goes (so the next try fetches it) and Settings says so.

## Tokens

### Color (all `--ut-…`)

| Group | Tokens | Old name |
| --- | --- | --- |
| Surfaces | `bg-app`, `surface-1`, `surface-2`, `surface-3`, `surface-raised`, `surface-hover`, `surface-selected`, `surface-preview` | `--color-bg`, `-bg-secondary`, `-bg-tertiary`, `-surface`, `-bg-elevated`, `-surface-hover`, `-selected`, `-preview-bg` |
| Overlays | `overlay` (45%), `overlay-soft` (25%), `overlay-35`, `overlay-medium` (40%), `overlay-strong` (50%), `float-bg`, `float-bg-solid`, `float-border`, `float-text`, `bubble-bg`, `bubble-frost` | new |
| Text | `text`, `text-bright`, `text-muted`, `text-dim`, `text-placeholder`, `text-on-accent`, `text-on-solid` | `--color-text*`, `-placeholder`, `-on-fill` |
| Accent | `accent`, `accent-hover`, `accent-strong`, `accent-light`, `accent-soft`, `accent-glow`, `accent-text`, `accent-ink`, `accent-icon` | `--color-primary*` |
| Borders | `border`, `border-strong`, `border-focus`, `focus-ring` | `--color-border*`, `-focus-ring` |
| States | `success`, `warning`, `danger`, `info` with `-text` (as text) and `-soft` (tint); `attention`, `attention-soft`, `attention-text`; `alive` | `--color-status-*`, `-attention*`, `-alive` |
| Hairlines | `hairline-dark`, `hairline-darker`, `hairline-neutral`, `hairline-light`, `edge-light` | new |
| Details | `knob`, `mix-lighten`, `mix-darken`, `mask-opaque`, `selection-handle`, `pulse-info`, `pulse-info-end` | new |
| Avatars | `avatar-live-bg/fg`, `avatar-attn-bg/fg`, `avatar-off-bg/fg` | `--color-avatar-*` |

### Shape, depth, type, density, motion, effects

| Group | Tokens | Tailwind |
| --- | --- | --- |
| Radii | `r-sm` 4, `r-md` 6, `r-lg` 10, `r-xl` 14, `r-pill`, `r-full`, `r-circle`, `r-avatar`, `r-avatar-sm`, `r-logo-xs`, `r-logo`, `r-logo-lg` (fixed: no style touches a logo or 3D icon), `r-badge-em`; `r-offset` multiplies the numbered ones (0 = square corners); off the scale, as an offset from those four: `r-1 2 3 5 7 8 9 12 13 16 18 20 22 26`; in rem: `r-rem-1 md lg xl 2xl 18 20 24` | `rounded-chip`, `-ctl`, `-card`, `-dialog`, `-rem`, `-pill`, `-md`, `-lg`, `-xl`, `-2xl` |
| Elevation | `elev-0` none, `elev-1` cards, `elev-2` popovers, `elev-3` dialogs; other drop shadows named `drop-<blur>-<opacity %>`, `drop-float-*`, `drop-sm/md/lg/2xl`; colored glows take their shape from `glow-<y>-<blur>` and add the color: `var(--ut-glow-0-8) color-mix(…)`. A shadow written by hand may only be a ring or stripe (no blur, offsets up to 6 px) in a token's color | `shadow-e1 e2 e3 card card-hover elevated drop-sm drop-md drop-lg drop-2xl` |
| Type | `font-ui`, `font-title` (wordmarks and titles only; follows `font-ui` unless a style sets it), `font-mono`, `font-ui-system`, `font-mono-system`, `fs-micro/caption/ui/title/display`, `lh-…`, `fw-normal/medium/semibold/bold` | `font-ui`, `font-mono`, `text-micro/caption/ui/title/display` |
| Density | `space-row`, `space-group`, `space-section`, `page-pad`, `ctl-h`, `tab-min-width` (phone tab bar) | `--space-*`, `--page-pad` |
| Motion | `dur-1/2/3`, `ease-out` | `--dur-*`, `--ease-out` |
| Effects | `backdrop`, `page-alpha`, `surface-alpha`, `panel-alpha`, `blur-surface`, `outline-width`, `surface-edge`, `control-relief`, `control-sheen`, `field-relief`, `effect-glow`: neutral by default, a style turns them on (see Backdrops and effects) | |

### Optional density and flat paint

Minimal claro follows Astra's spacing as well as its palette. Optional `--ut-*` values in the
owning shared pieces retain their previous literal as the fallback, so another look does not
inherit this layout. `--ut-list-columns` selects one column in both session and task grids;
the existing grid observer reads that column count before computing repository spans.
`--ut-home-header-h`, `--ut-sidebar-header-h`, `--ut-brand-size/line`, `--ut-workspace-top`,
`--ut-side-row-h/pad`, `--ut-side-title-size/line` control desktop chrome and sidebar density.
`--ut-needs-*` controls the strip's head, row, title, metadata and action typography; the
`--ut-phone-needs-*` and `--ut-phone-row-*` sizes keep mobile usable instead of copying desktop.
`--ut-action-h/size/line/pad/radius/weight`, `--ut-control-size/line`, `--ut-settings-row-h/pad`
and `--ut-description-size/line` enlarge controls and settings. `--ut-task-title-*`,
`--ut-detail-*`, `--ut-record-size/line` carry the hierarchy into the task and log sheets.
`--ut-section-actions-end` keeps preview/project actions inside their section; its fallback
retains the previous negative margin for other looks, while Minimal claro uses zero.

`--ut-chat-canvas` optionally gives the chat and its composer the workspace background without
changing the terminal palette or its pixels. Flat paint also crosses shadow roots via tokens: `--ut-segment-selected-bg/ink/shadow` supplies
an underline, `--ut-composer-*` frames the entry, and `--ut-banner-*` makes the shield notice a
separated row. Optional `--ut-press-filter`, `--ut-control-hover-transform` and
`--ut-control-active-transform` let a flat style remove control movement without touching images.
Off-scale drop shadows are zero transparent paint (safe in composite shadow lists), while the
three elevation tokens are `none`. Floating shared pieces have an outline without layout borders.
No new texture is used: Astra explicitly specifies no grain, gradient, blur or volume.

`--ut-chat-column` is the width of the desktop chat's column: the conversation (`claude-chat-view`)
and the composer under it (`terminal-chat-view`) both read it, so they stay in line. By default it is
the whole chat area less `--ut-chat-margin` (32 px) on each side, with no ceiling, in any window
(1280 to 3440 px and beyond); below `--ut-chat-column-from` (1000 px of chat area, and on phones) it is
the `--ut-chat-column-floor` (720 px) of before, growing from there without a jump. "Chat width" in
Settings → Appearance (`utils/chat-width.ts`, per device) has two choices: Full (the default, no
attribute) and Comfortable (`data-chat-width="comfortable"` on `<html>`: the 720 px column, bubbles
at 82 %). A saved "wide" (removed) reads as Full. `--ut-chat-bubble-max` is a bubble's widest share
of the column (82 % at the floor, 90 % in a wider one: the breather on the other side tells who
speaks); running text has no measure, so a bubble grows with its text. Code, tables and images
follow the same bubble. A style changes these values, never the components. `ui-shots.mjs` views:
`chat-wide-1440`, `chat-wide-2000` and `chat-wide-3440` (in `--audit-layout`, which checks the composer
lines up with the column and the bubbles reach the token), and `chat-comfortable-*` on request.

Small non-text controls can use `--ut-indicator-fill/hover` (switch track, slider thumb and
progress) independently of bright button fills. `--ut-choice-border/selected-border/dot`
keeps unchecked boundaries, checked boundaries and the radio dot above 3:1. The defaults retain
the previous accent, border and knob colors; Minimal claro uses its darker orange for indicators.

The style forces light and its own orange; previous theme/accent choices remain saved. Evidence
and the full coverage inventory: [Minimal claro](verification/minimal-light/README.md).

A radius named by a number (`--ut-r-12`) says its default size; it is an offset of a base radius, so changing `r-sm/md/lg/xl`
moves it too.

## Shared pieces

In `styles/foundation/ut-*.css` (`@layer components`) and `styles/list/*.css`: use them instead of a new set of declarations.

| Piece | Class |
| --- | --- |
| Surface | `.ut-surface` with `data-level="0"`, `"2"`, `"3"` or `"raised"` (default level 1): background, text, `blur-surface`, `surface-alpha` |
| Card, row | `.ut-card`, `.ut-group` + `.ut-row`, `.ut-row-label`, `.ut-row-desc` |
| Button | `.ut-btn` + `--primary`, `--secondary`, `--ghost`, `--danger`, `--danger-ghost`, `--sm`, `--lg`; `.ut-icon-btn(--sm)` |
| Chip, label, pill | `.ut-chip(--mono)`, `.ut-status[data-status]`, `.ut-kbd`, `.ut-label` |
| Input | `.ut-field(--mono)`, `.ut-select`, `.ut-switch`, `.ut-segmented` |
| Sheet, dialog | `.ut-dialog(--sm/--md/--lg/--palette)` + `-header`, `-body`, `-footer`; phone sheets `.p-sheet` |
| Section header | `.ut-section-label` |
| Divider | `.ut-divider` |
| Badge | `.ut-badge` + `--accent`, `--success`, `--warning`, `--danger`, `--info`; `.ut-badge-dot` |
| Tooltip | `.ut-tooltip` |
| Menu, toast | `.ut-menu`, `.ut-menu-item`, `.ut-toast` |
| Long title | Around the two parts `midCutTitle()` (`utils/card-line.ts`) gives a title: its start (`.ut-mid-start`) and its end (`.ut-mid-end`, its last whole words). `.ut-title-lines` where the row can grow (task cards and rows): two lines, and while even two cut it (`data-cut`, kept by `fitTitleLines()`) the start with «…» on the first and the end on the second. `.ut-mid` where only one line fits (sidebar task rows, «Te necesita»): the start is cut with «…» and the end stays whole: «Revisión 2ª vuelta: arr… del servidor». The start gives way first, down to the room of its «…» (`--ut-mid-start-min`, 2em; 1em for a start of a few letters); only then the end, which goes word by word (`.ut-mid-word`), lets go of its first words, whole: never a letter gone without «…», whatever the type's size. With no room even for one word, the end leaves the line and the title is cut at its end like any other (`data-leave`, beside a start long enough to be cut then), or its last word is cut with its own «…» (beside a short start). A title that fits is whole. Never a title cut at its end only: `--audit-layout` fails with `titles-read-the-same` when two rows of one project show the same words for different titles, and with `title-letters-eaten`, `title-cut-without-ellipsis`, `title-end-gone`, `title-halves-overlap`, `title-halves-joined` or `title-cut-with-room` when a title cut in the middle does not read «start… end»; see it with `--views mobile,mobile-320,mobile-wide,mobile-queue,mobile-queue-320,mobile-queue-440,desktop` |

The `.ut-surface`, `.ut-divider` and `.ut-badge` pieces are new and not used by any screen yet: the rest of the screens already
use the other shared pieces or tokens directly.

Never changed by a style: project logos, 3D icons, agent and provider avatars, user images, the terminal's contents (ghostty-web),
and the terminal's charts and status colors. `looks.test.ts` guards the token names and selectors a style may use;
`node web/scripts/ui-shots.mjs --look <id> --check-untouchables` compares the computed style of logos, 3D icons and the
terminal with Original in a real browser.

## Inventory on 2026-11-09, before this migration

- 2,707 uses of `var(--…)`, 469 hex and 48 `rgb()/hsl()` in CSS, 603 hex and 29 `rgb()/hsl()` in TypeScript (528 of them in
  `utils/terminal-themes.ts`).
- 166 radii written by hand (of 225), 91 `box-shadow`, and Tailwind classes that skip the tokens (`rounded`, `rounded-full`,
  `shadow-sm/md/lg/2xl`, `text-white`).

Still written by hand, on purpose: font sizes and spacing (`padding`, `gap`, `margin`). They come from the type scale and
density tokens where a piece uses them, but the guard does not check them yet: moving them needs its own step, and they
are the likeliest source of visual changes when a style changes the type or density.

## Exceptions

Listed with their reason in `ui-tokens-guard.test.ts`, and each must still apply or the test fails, so the list only
shrinks:

- Whole files: `styles/tokens.css` and the values files `styles/looks/<id>.css` (not their `*.effects.css`, held to the rule); terminal content (`utils/terminal-themes.ts`, `utils/terminal-renderer.ts`,
  `components/terminal.ts`, `components/terminal-peek-row.ts`, `components/terminal-theme-picker.ts`);
  the code editor (`utils/monaco-loader.ts`); the logo (`components/terminal-icon.ts`); the accent picker's swatches;
  `sw-offline.ts` and the crypto error banner (`services/ssh-agent.ts`), which must render without the stylesheet.
- Lines: the 256 terminal colors, cursor and links in `styles/foundation/terminal.css` and the scanlines in
  `terminal-exited.css`; the Claude, shell and tool avatar tiles (`phone-rows.css`, `start-screen.css`); the
  text of the terminal's IME field; the hex fallback in
  `utils/theme-utils.ts`.

## Proving no visual change

`web/scripts/ui-shots.mjs` takes screenshots from the twin with fictitious data (WebKit and Chromium, nine views:
`mobile`, `desktop`, `task`, `session`, `chat`, `settings`, `settings-desktop`, `create`, `create-desktop`), and
`web/scripts/ui-shots-diff.mjs` compares two folders. The views are a registry in `web/scripts/ui-shots/views/`, one
file per group (`home.mjs`, `task.mjs`, `session.mjs`, `dialogs.mjs`, `projects.mjs`): a new view is one entry in
its group's file (what an entry holds is at the top of `views/helpers.mjs`), never an edit to the tool.

```bash
node web/scripts/ui-shots.mjs --theme light --out /tmp/before   # also dark, --theme light --accent gold, --theme dark --accent ocean
# …change the code…
node web/scripts/ui-shots.mjs --theme light --out /tmp/after
node web/scripts/ui-shots-diff.mjs /tmp/before /tmp/after --out /tmp/diff
```

With a style: `--look <id>` (captures its supported modes), `--views appearance` (the picker), `--gallery` (every style and
mode in `gallery.png`, for sending).

A pixel counts when a channel moves more than 3 of 255 (`--channel-delta`), and a view fails above 12 such pixels
(`--max-pixels`). Two runs of the same code differ by at most 1/255 on 2 of 72 views. Exit 1 means something changed:
`--out` then holds, per failed view, the picture with the changes in red.

## Style coverage checklist (Clay audit, 2026-11-09)

Use this inventory for **every** look, on WebKit at 390×844 and 1440×900. A colored surface alone
is not covered: compare its material, outline, relief, focus, selected/pressed/disabled states,
legibility and clipping with the design reference. Record `clay`/`liso` (or the equivalent for
the next style), the view and the reason for every deliberate exception. Do not infer coverage
from the list screenshot: shadow roots, portalled sheets and browser controls have separate paint.
Inspect selected rows separately: Agents uses a different renderer when selecting. For nested
editors, also verify the foreground hit target, not just DOM visibility (the quick-keys editor
used to be behind the 2001 phone sheet; it now uses `Z_INDEX.SHEET_EDITOR`).

The detailed Clay evidence was a before/after report made with `ui-shots-report.mjs`. Its pictures and
generated data are not kept in the repository (with the other styles' captures they were 97 MB by
2026-11-11); the commands below make them again.
It contained **184 before/after pairs**: 115 screen/state captures, 19 overflow positions and
50 complete Appearance cards (25 styles × two sizes).
The final run passed all 115 views on both sides, 3,265 client tests (22 existing skips),
130 focused guards and five real twin/script integration tests. Original matches in 22
light/dark control captures. Painted contrast: at least 4.659:1 across 12 surface pairs in
each engine; four existing texture assets remain 71,000 bytes, with offline/cache/SHA checks.
WebKit scroll samples on this Mac (three × 180 frames per viewport): phone p95 17 ms before,
17–18 ms after; desktop p95 17–19 ms before, 18 ms after. No after frame exceeded 25 ms.
These are host-browser measurements, not physical iPhone FPS. The separate
59 px safe-area capture checked geometry; a physical iOS
installation was not used. Every tested header/ancestor/pseudo layer reports `filter: none`
and `backdrop-filter: none`.
The source references were `clay-maqueta-lista.png` and `clay-maqueta-tarea.png` in
`~/Projects/estilos-diseno/out/`; `clay-v1-movil-real.jpg` is the old phone appearance, **not** the
baseline for this task. The before captures are the merged v2 checkout.

| Check | Piece / states to inspect | Clay v2 inventory | Shared coverage / capture |
| --- | --- | --- | --- |
| [x] | Home header, logo area, clock safe area, scrolled header | clay, diffuse rim / native edge exposure | `.ut-surface--bar`; `mobile`, safe-area audit. Solid, sharp rim, no CSS blur |
| [x] | Session list, cards, state colors, project headings, compact sidebar | clay; ancillary actions liso | material rows plus controls; `mobile`, `mobile-rows`, `desktop-home`, `desktop` and their scrolls |
| [x] | Needs-you band, expanded band, question/reply, countdown | band clay; question controls liso | `task-question`, `task-countdown`, `answer`; shared floating, inset and control pieces |
| [x] | Task detail, failure, record, actions | detail/record clay; sheet frame liso | `task`, `task-desktop`, `task-log`; keep v2 state palette |
| [x] | Terminal session: header, toolbar, tabs, switcher, menu | desktop header clay; phone bar/actions/menu liso | `session`, `session-menu`, `session-switcher`, `session-width` |
| [x] | Chat: incoming/outgoing messages, activity, composer, attachments, prompt dock/editor | liso | neutral material tokens and shared shadow-root material; `chat`, `session-chat`, `session-attach`, `session-prompts`, `answer` |
| [x] | Agents: cards, select/broadcast controls, empty state | rows clay; toolbar/empty/selection liso | `agents`, `agents-select`, `agents-empty` |
| [x] | Settings root and section navigation | smooth relief, no v2 grain | material panel/rows; `settings`, `settings-desktop` |
| [x] | General, Appearance, Terminal, Notifications, Sessions, This Mac, Advanced | frames/navigation and some controls liso | `settings-<section>` for every section, both sizes, all overflow positions; Appearance cards individually |
| [x] | Appearance picker cards, selected look, mode, accent controls | liso cards; miniatures intentionally depict their own style | `settings-appearance`, `appearance`; material outside the thumbnail |
| [x] | Fields, search, select, disabled/focused inputs, checkboxes | some controls clay; legacy fields liso | `.ut-field`, `.ut-select`, inset; `create`, `task-compose`, `project-settings`, `pieces`, `login` |
| [x] | Switches, selected/unselected segments, tabs, quick keys | partial relief, missing grain | base pieces and neutral track/thumb tokens; `settings-terminal`, `session-width`, `quick-keys`, `pieces` |
| [x] | Sliders and progress bars | liso | neutral track/thumb material; `pieces` is a labelled specimen (there is currently no live settings slider); chat status meters use the same tokens |
| [x] | Chips, badges, keyboard hints, counters | partial/liso | badge/control material; list, header, palette, settings and `pieces` |
| [x] | Content sheets, action sheets, confirmation, create/project/scheduled-task dialogs | liso phone frames | `.ut-surface--floating`, material; `confirm`, `new-project`, `project-settings`, `scheduled`, `create`, `task-compose` |
| [x] | Menus, context actions, dropdowns and popovers | mostly liso | shared floating/control; `home-menu`, `session-menu`, `preview-menu`, `session-attach`, `palette` |
| [x] | Toasts (success/info/attention/error), banners, notices | toast partly clay; legacy notices liso | `toasts`, settings notifications, shield banner, `whats-new` |
| [x] | Rich tooltip | liso | `.ut-tooltip`; `pieces` specimen; browser `title` is a native exception |
| [x] | Empty/search/no-agent states | liso | material panels; `empty`, `agents-empty`, preview unavailable |
| [x] | Preview screen, active/unavailable preview, split mobile panel | rows clay; viewer chrome liso | `preview`, `preview-down`, `session-preview`; controls/bars, iframe intact |
| [x] | File browser, changes, copy panel, palette and login | frames/controls liso | `session-files`, `session-changes`, `session-copy`, `palette`, `login`; code/content keeps its own rendering |
| [x] | Share links, quick keys/editor, quick-start editor, Mac file picker | liso frames and controls | `session-share`, `session-keys`, `quick-keys`, `quick-start`, `session-mac-picker` |
| [x] | Voice sheet, worktrees, Git initialization, orchestrator and approval sheet | liso | `session-copilot`, `session-worktrees`, `git-init`, `orchestrator`, `task-confirm`; voice fixture does not activate microphone/audio/provider |
| [x] | Standalone diagnostic log viewer | liso controls; selected style sheet never loaded | `logs`; shares the saved/server style loader, material bars/controls, fictitious log entries; code text intact |
| [x] | Project logos, provider/agent images, 3D icons, attachments | intentionally original | untouchables audit; never materialize an image or filter a container |
| [x] | AA, focus, reduced motion/transparency, overflow, offline textures, scrolling | retain existing guarantees | contrast tests + painted audit + full client tests + scroll samples + Original comparison |

### Shared pieces added by the coverage audit

- `.ut-surface--floating` gives application sheets their own app-palette surface. Its material is
  separate from `--ut-float-*`, which remain reserved for terminal overlays and **forbidden in
  looks**. Phone sheets do not become terminal overlays just because they float. The effects
  layer only decorates shared pieces; it contains no screen-specific selectors.
- Paint-only `--panel`, `--control`, `--inset`, `--badge` and `--primary` hooks retain the caller's
  layout and semantics. A primary action explicitly opts into `--primary`.
  Floating decoration paints its outline through the elevation token, without adding a layout
  border: an extra 1 px border shrank full-height sheets and caused WebKit to alternate 26 edge
  pixels by 1/255. Removing that border stabilized the actual paint; screenshot tolerances stay
  unchanged. Keep scroll offsets integral when generating the inventory.
- `.ut-text-action` is impressed lettering on an existing surface (neutral `--ut-piece-text-shadow`).
  Inline links and section disclosures should not become extra slabs that cover adjacent text.
- `--material` still positions a local empty paint layer. A fixed sheet also opts into `--fixed`.
  **Position is not an inherited custom property**: it once made every settings row fixed at
  the same coordinate. Coverage captures now fail if settings rows overlap or inherit fixed
  positioning. Never add material geometry to an element without checking its original positioning.
- `utils/material-surface-styles.ts` supplies the same empty paint layer inside shadow roots.
  Chat and compositor surfaces are already positioned. The pseudo-element alone takes opacity
  and blending; the messages, code, images and hit targets do not.
- Neutral `--ut-piece-grain`, `-grain-size`, `-grain-blend`, `-raised`, `-inset`, `-control`, `-edge`,
  `-track`, `-thumb` carry material across shadow boundaries. Neutral shadows are `0 0 transparent`,
  not `none`: `none` cannot be one entry in a comma-separated shadow list. Existing shadows stay
  as their own layers. Optional `--ut-piece-control-fill` supplies opaque material behind a tile
  on a previously transparent control; otherwise blending the tile yields a silver control.
  `--ut-piece-control-radius` optionally rounds previously square shadow-root icon controls.
- `--ut-chat-incoming-fill` / `-outgoing-fill` optionally color chat bubbles, with their original
  colors as fallbacks. They do not change the terminal or the chat/header/composer canvas contract.
- `.ut-range` / `.ut-progress` and chat status meters consume the track/thumb tokens. Keep WebKit
  and Mozilla pseudo-element rules separate: an unsupported pseudo-element invalidates an entire
  selector list in WebKit.
- `--ut-header-blur` and `--ut-toolbar-blur` preserve their original 12/10 px defaults; Clay sets
  both to `none`. Its top bar has a sharp, unblurred rim instead of the diffuse nine-slice border.
  Installed iOS still needs the safe-area **plus** scroll-edge protection (40 px in portrait,
  zero extra when the inset is zero). Desktop Playwright WebKit does not emulate iOS system chrome;
  the separate Chromium 59 px safe-area case checks the geometry, not a physical iPhone.

### Reproducing the coverage evidence

```bash
node web/scripts/ui-shots.mjs --look clay --browsers webkit --coverage --out /tmp/clay-before
# Save web/public before changing client sources if more inventory scenes may be needed.
# --built deliberately uses the current bundle; --assets <snapshot-of-public> freezes its static files.
node web/scripts/ui-shots.mjs --look clay --browsers webkit --coverage --out /tmp/clay-after
node web/scripts/ui-shots-diff.mjs /tmp/clay-before /tmp/clay-after --out /tmp/clay-diff
node web/scripts/ui-shots-report.mjs /tmp/clay-before /tmp/clay-after /tmp/clay-report
node web/scripts/ui-shots.mjs --look clay --browsers webkit,chromium --views mobile,desktop-home --audit-layout --measure-scroll --out /tmp/clay-audit
```

`--coverage` adds the inventory views without changing the nine default views used by existing
tests. `--coverage --views ...` restricts the run. It records each scroll increment (Appearance
captures every complete card with a locator screenshot, avoiding clipped shadow edges) and a
`*-pieces.json` inventory, including shadow roots, and reports failures without pretending that
an unopened view passed. Rare transient states use real component APIs with fictitious data;
`pieces` is explicitly a specimen. These fixtures and their bundle are never shipped.
The preview fixture enables the viewer and serves the twin keeper's fictitious page through a
deterministic ticket; it checks UI, not preview authentication. Git initialization uses fictitious
preview/review responses without invoking an agent or creating a repository. Project settings
resolve a real repository from the twin's session metadata: `rich.projects` only contains display
names. The v2 quick-keys comparison lifts its old z-index to expose its original paint; the current
capture asserts that the unmodified editor is above Settings. The delayed automatic Novedades
notice is marked seen in the fixture and captured explicitly in its own scene, so it cannot
cover a later scroll. The countdown fixture supplies `autoMergeAt` through the board response
and brings that exact task into view; the question scene opens its actual free-text answer
sheet, while `answer` covers explicit permission choices. The log scene has deterministic
nonempty output. Its timestamps/client messages keep the contrast-token color at full opacity. Legacy quick-start/worktree inputs opt into the same inset/control pieces.

Deliberately still **liso/original**: terminal pixels/ANSI colors, code/diff contents, user images,
logos/3D icons, the website inside preview iframes, browser/OS native select popups, `title`
tooltips, file chooser and keyboard. They are content or system UI, not app material. The small
Appearance/terminal-theme previews must faithfully show the selected style/theme. Plain gaps,
dividers and scrims are not raised controls; adding shadows to them would obscure the hierarchy.

### Clay final proportion and edge review (2026-11-09)

Before/after A–G and the eight iPhone details (a report of 2026-11-09, not kept in the repository) supersede the material
coverage pictures above for Clay's proportions, hierarchy and corners. The original nine WebKit
screenshots and the user's eight real iPhone crops are identified separately from the twin captures.
The detailed comparisons include a deterministic WebKit before/after with 59 px top / 34 px bottom
insets. These are simulated `env()` values; Playwright WebKit does not reproduce native iOS
scroll-edge compositing. Chromium additionally exercises native CDP safe-area overrides.

- Keep small painted controls inside their owner, with shallow relief and 44 px touch halos.
  Raised bottom bars reserve space for shadows as well as the bottom safe area.
- Section disclosures and inline text actions use `.ut-text-action`; a task status line is not
  a raised badge. Primary actions opt into `.ut-surface--primary`. Neutral paint precedes
  selected/pressed/primary paint, so cream controls cannot erase yellow selection or terracotta.
- Large dialogs/panels use restrained fine grain; colored rows retain the fingerprints. Cream
  wells use `--ut-well-fill` / `--ut-well-grain` across shadow roots. The desktop composer's inner
  capsule must not add another square inset inside its rounded well.
- Material layers inherit the host radius, with zero inset and a rounded inset shadow. Clay no
  longer uses the nine-slice border image or a separate fixed-radius clip: WebKit showed a second
  contour and square artifacts. The old image remains a cached asset for now, unused by Clay.
- Miniature overrides have defaults in `tokens.css` so another look's miniature cannot inherit
  Clay's blue row or relief. Settings has colored icon tiles and yellow selection at both sizes.
- The orchestrator label supplies its distinction in Clay. Its surrounding accent stripe and
  tinted rectangular frame are disabled with neutral fallback tokens for other looks.

```bash
# Every look uses the same geometry/state audit.
node web/scripts/ui-shots.mjs --look clay --browsers webkit,chromium --audit-layout --views mobile,session,task,create,settings,settings-desktop,appearance,desktop,chat,mobile-rows,coverage-session-chat-mobile --out /tmp/clay-final
node web/scripts/ui-shots.mjs --look clay --browsers webkit,chromium --audit-layout --safe-area --views mobile,session,mobile-rows,coverage-session-chat-mobile --out /tmp/clay-safe
cd web && pnpm run test:ui-audits   # node --test scripts/ui-layout-audit.test.mjs
```

`ui-layout-audit.mjs` walks light and shadow DOM. It checks control bounds and relief against their
bar/row, viewport and clipping ancestors; primary/selected color against peers; and material
radius, inset, clip and nine-slice inconsistencies. It distinguishes scrolling content, fixed
chrome, containing blocks, `display: contents`, and transparent tap halos. `--safe-area` substitutes
only the twin's static CSS/JS `env()` values, including Lit styles, and checks chrome against the
59/34 safe region. Two `.ut-surface--bar` one over the other are one surface (`stacked-bar-…`: the one on top has no bottom corners, edge or shadow of its own, and nothing of the page shows between them or at their ends). Each view writes a `*-layout-audit.json`; any failure makes the run fail while
retaining the other views' evidence. `mobile-rows` positions an ordinary session menu below the
sticky header, after safe-area layout settles; `mobile-composer` does the same for the home input. The browser tests deliberately break each invariant
in both engines, then verify the corrected rendering. The unchanged old bundle fails this audit.

### Cyber / Hacker — Astra recipe (2026-11-09)

[Coverage, before/after, reference mockups and measured limits](verification/cyber-hacker-astra/README.md).
Dark-only phosphor console with the recipe's density scale, a seamless 32 px CSS grid and static
4 px log scanlines. No new runtime assets. Shared request-action, segment, danger and selected-row
hooks carry paint without changing behavior. Optional `--ut-btn-pad`, `--ut-section-size/line`,
`--ut-workspace-backdrop/size`, `--ut-compact-bar-h`, `--ut-disabled-opacity` and
`--ut-look-selected-bg` retain their old fallbacks for other looks. The selected row's cursor must
follow neutral material paint; otherwise the four corner gradients erase it. Dark segmented
controls honor `--ut-segment-selected-bg/shadow` just as light controls do.

The style's own one-off audit (`--audit-cyber-hacker`: dimensions, forced mode, reflow, focus, disabled
controls, indicator contrast and six painted backgrounds) was run for this work and removed on 2026-11-11.
`--views desktop-selected` navigates a
real sidebar row to verify its block cursor. `ui-shots-report.mjs <before> <after> <out> cyber-hacker`
labels portable comparisons for this style and preserves unequal locator-image proportions.
