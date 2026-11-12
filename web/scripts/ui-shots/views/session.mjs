// A session: its terminal on the phone, and in chat mode on the desktop.
import { DESKTOP, PHONE, openSession } from './helpers.mjs';

// A fictitious agent conversation with what a wide desktop chat has to show (a user's 3440 px
// screenshot, 2026-11-11): a long agent text that used to stop at 76 characters pinned left, a short
// user message pinned right, a user message with an attached image, a code block, a table and a
// tool's diff. The image is the file the twin never has: wideChat serves it.
const LONG_TEXT =
  'He revisado la vista de chat y el compositor. La conversación se pinta en una columna centrada con un ancho fijo pensado como medida de lectura, de modo que en una ventana grande más de la mitad del espacio queda vacío a los lados y los bloques anchos acaban con desplazamiento horizontal dentro de una burbuja estrecha. Además el texto corrido llevaba un tope de unos setenta y seis caracteres por línea, así que en un monitor ultrapanorámico la respuesta del agente se quedaba pegada a la izquierda, la del usuario a la derecha y en medio quedaba un hueco enorme que no aporta nada a quien lee.\n\nLo que propongo es que, por defecto, la columna ocupe todo el ancho del área del chat con un margen lateral cómodo, y que las burbujas crezcan con el texto hasta casi toda la columna, cada una desde su lado, dejando un respiro del lado contrario para que se distinga quién habla. El ajuste «Ancho del chat» se queda con dos opciones: «Completo» y «Cómodo», la columna de 720 px de antes, para quien prefiera líneas cortas.\n\nEsta es la regla que decide el ancho, ahora sin techo:\n\n```ts\nexport function chatColumnWidth(area: number, floor = 720, margin = 32): number { return Math.max(floor, area - 2 * margin); } // todo el área menos el margen\nconst widths = [1280, 1440, 2000, 2560, 3440].map((area) => ({ area, column: chatColumnWidth(area), bubble: Math.round(chatColumnWidth(area) * 0.9) }));\n```\n\nY el resultado en las ventanas más habituales:\n\n| Ventana | Área del chat | Columna «Cómodo» | Columna «Completo» | Burbuja del agente | Bloques de código y tablas |\n| --- | ---: | ---: | ---: | ---: | --- |\n| Portátil de 13 pulgadas | 1280 px | 720 px | 1216 px | 1094 px | Ocupan toda la columna |\n| Monitor de 27 pulgadas | 2560 px | 720 px | 2496 px | 2246 px | Ocupan toda la columna |\n| Ultrapanorámico | 3440 px | 720 px | 3376 px | 3038 px | Ocupan toda la columna |\n\nEn el móvil y en ventanas estrechas nada cambia.';
const WIDE_CHAT = [
  ['user', 'El chat de escritorio se queda en una columna estrecha en mi monitor grande. ¿Puedes revisar por qué y dejarme un resumen con el código y los números?'],
  ['assistant', LONG_TEXT],
  ['user', 'Perfecto, aplícalo.'],
  ['user', '/Users/alex/.untether/control/uploads/wide-ultrawide.jpg así se ve hoy en mi monitor'],
  ['tool', 'web/src/client/styles/tokens.css', { tool: 'Edit', diff: ['#web/src/client/styles/tokens.css', ' :root {', '-  --ut-chat-column: clamp(var(--ut-chat-column-floor), var(--ut-chat-column-fluid), var(--ut-chat-column-ceiling));', '+  --ut-chat-column: max(var(--ut-chat-column-floor), min(calc(100% - 2 * var(--ut-chat-margin)), …));', ' }'] }],
  ['assistant', 'Hecho: la columna y el compositor ocupan todo el ancho y quedan alineados.'],
];

// A fictitious screenshot for the user's attached image.
const UPLOADED_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260"><rect width="640" height="260" fill="#2b3a4a"/><rect x="24" y="24" width="180" height="212" fill="#3d5168"/><rect x="224" y="24" width="392" height="96" fill="#4a6280"/><rect x="224" y="140" width="392" height="96" fill="#35475c"/></svg>';

/**
 * What the default (full) chat promises, measured on the page: the composer card lines up with the
 * conversation's column, nothing overflows sideways, and an agent's bubble reaches most of the
 * column instead of stopping at a text measure. Throws when it does not hold.
 */
async function expectFullChat(page) {
  const seen = await page.evaluate(() => {
    const chat = document.querySelector('claude-chat-view');
    const scroller = chat.shadowRoot.querySelector('.scroller');
    const css = getComputedStyle(scroller);
    const box = scroller.getBoundingClientRect();
    const column = { left: box.left + parseFloat(css.paddingLeft), right: box.right - parseFloat(css.paddingRight) };
    const composerHost = document.querySelector('terminal-chat-view[composeronly]') ?? document.querySelector('terminal-chat-view');
    const composer = composerHost.shadowRoot.querySelector('.chat-input-container').getBoundingClientRect();
    const assistant = [...chat.shadowRoot.querySelectorAll('.row.assistant .bubble')].map(b => b.getBoundingClientRect().width);
    return { column, composer: { left: composer.left, right: composer.right }, widest: Math.max(...assistant), overflow: scroller.scrollWidth - scroller.clientWidth, area: box.width };
  });
  const width = seen.column.right - seen.column.left;
  const problems = [];
  if (Math.abs(seen.composer.left - seen.column.left) > 1 || Math.abs(seen.composer.right - seen.column.right) > 1) problems.push(`composer ${JSON.stringify(seen.composer)} is not the column ${JSON.stringify(seen.column)}`);
  if (seen.overflow > 0) problems.push(`the conversation overflows by ${seen.overflow}px`);
  if (width > 800 && seen.widest < width * 0.8) problems.push(`the widest agent bubble (${Math.round(seen.widest)}px) stops short of the column (${Math.round(width)}px)`);
  if (seen.area > 1000 && width < seen.area - 64 - 1) problems.push(`the column (${Math.round(width)}px) leaves more than the 32 px margins of the ${Math.round(seen.area)}px chat area empty`);
  if (problems.length) throw new Error(`full chat layout: ${problems.join('; ')}`);
}

/** A desktop session in chat mode showing WIDE_CHAT, with the "Chat width" setting given. */
function wideChat(name, width, height, chatWidth, extra = {}) {
  return {
    name,
    viewport: { width, height },
    phone: false,
    ...extra,
    async open(page, ctx) {
      const start = new Date(ctx.rich.now).getTime() - 20 * 60_000;
      const messages = WIDE_CHAT.map(([role, text, more], index) => ({
        id: `wide-${index}`,
        role,
        text,
        timestamp: new Date(start + index * 60_000).toISOString(),
        ...more,
      }));
      await page.route(
        (target) => /^\/api\/sessions\/[^/]+\/claude-chat$/.test(target.pathname),
        (route) => route.fulfill({ json: { available: true, status: 'idle', agent: 'claude', title: 'Ancho del chat en escritorio', messages, messagesVersion: 'wide' } })
      );
      await page.route(
        (target) => target.pathname === '/api/files/wide-ultrawide.jpg',
        (route) => route.fulfill({ contentType: 'image/svg+xml', body: UPLOADED_IMAGE_SVG })
      );
      // The default (full) is no saved choice at all.
      if (chatWidth) await page.addInitScript((value) => localStorage.setItem('ut-chat-width', value), chatWidth);
      await openSession(page, ctx);
      await page.getByTestId('chat-mode-toggle-button').click();
      await page.locator('claude-chat-view .bubble').first().waitFor({ state: 'visible' });
      if (!chatWidth) await expectFullChat(page);
    },
  };
}

export default [
  // 390x844, a session.
  {
    name: 'session',
    ...PHONE,
    base: true,
    terminal: true,
    open: (page, ctx) => openSession(page, ctx, 'chat-mode-toggle-button-compact'),
  },
  // 1440x900, a session in chat mode.
  {
    name: 'chat',
    ...DESKTOP,
    base: true,
    async open(page, ctx) {
      await openSession(page, ctx);
      await page.getByTestId('chat-mode-toggle-button').click();
      await page.locator('claude-chat-view, terminal-chat-view').first().waitFor({ state: 'visible' });
    },
  },
  // An agent's conversation in the desktop chat at the default "Chat width" (full) on a laptop, a
  // large monitor and an ultrawide; "comfortable" (720 px) is a view on request.
  wideChat('chat-wide-1440', 1440, 900, null, { audit: true }),
  wideChat('chat-wide-2000', 2000, 1100, null, { audit: true }),
  wideChat('chat-wide-3440', 3440, 1300, null, { audit: true }),
  wideChat('chat-comfortable-1440', 1440, 900, 'comfortable'),
  wideChat('chat-comfortable-3440', 3440, 1300, 'comfortable'),
];
