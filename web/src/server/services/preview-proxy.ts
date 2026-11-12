/**
 * Dev-server preview: `/preview/<port>/...` proxies to a dev server on this Mac's loopback
 * interface so the phone can see a vite/next app running in a session, inside the app.
 *
 * Why a path prefix plus a service worker (2026-10-03):
 * - Each app has a separate hostname; path prefixes are only for routing, never isolation.
 *   Remote previews require wildcard DNS/TLS routing to the preview listener. Tailscale's
 *   single shared hostname cannot safely host multiple apps.
 * - Dev servers emit root-relative URLs everywhere (`/@vite/client`, `/src/main.ts`,
 *   `/node_modules/.vite/deps/…`, `/_next/static/…`), also inside JS imports that HTML
 *   rewriting can't reach. So the first load of `/preview/<port>/` returns a tiny bootstrap
 *   page that registers a service worker scoped to `/preview/<port>/`. That worker puts the
 *   prefix back on every root-relative request of the previewed page, answering with a
 *   response that keeps the request URL (no double module instances).
 * - WebSockets don't go through service workers: a script injected into proxied HTML wraps
 *   `WebSocket` so the HMR socket (`wss://host/?token=…`, `/_next/webpack-hmr`) goes to
 *   `/preview/<port>/…` and is proxied as an authenticated upgrade.
 * - The same script moves the page's URL to the app's own path (`replaceState`), so routers
 *   see `/about`, not `/preview/5173/about`. A later full load of that path inside the
 *   iframe (reload, plain link) is sent back under the prefix by `redirectStrayIframeLoad`.
 *
 * Separate origin (2026-10-03): the previewed app's JavaScript (and every npm dependency of
 * the dev project) used to run on Untether's own origin, where it could read the
 * Untether token from localStorage and call /api with it. Previews are now served only by
 * a second listener on its own port (main port + 1 by default, see preview-server.ts), with
 * a separate hostname per app, so the browser isolates storage and the API by origin.
 * That listener has its own auth: the
 * authenticated main API mints a 60 s single-use ticket (POST /api/preview/ticket), the
 * iframe opens `/__ut_preview_login?ticket=…` on the preview origin, which burns it and sets
 * an HttpOnly, host-only cookie bound to that app. No main-origin credential is
 * accepted here, and the preview cookie means nothing to the main API.
 *
 * Also: only 127.0.0.1/::1 on ports 1024-65535 that aren't Untether's own; Untether
 * credentials are never forwarded; frame-blocking headers are removed only from proxied
 * responses and replaced by `frame-ancestors <the Untether origin that asked>`.
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('preview-proxy');

export const PREVIEW_PREFIX = '/preview/';
/** Session cookie on the preview origin, one per port: `ut_preview_5173`. */
export const PREVIEW_COOKIE = 'ut_preview';
export const previewCookieName = (port: number) => `${PREVIEW_COOKIE}_${port}`;
export const PREVIEW_LOGIN_PATH = '/__ut_preview_login';
/** Non-secret marker: which port the last preview iframe showed (for stray iframe loads). */
export const PREVIEW_PORT_COOKIE = 'ut_preview_port';
/** Header the preview service worker adds: the bootstrap page isn't needed any more. */
export const PREVIEW_SW_HEADER = 'x-ut-preview-sw';
export const PREVIEW_SW_FILE = '__ut_preview_sw.js';
export const PREVIEW_CLIENT_FILE = '__ut_preview_client.js';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;

export interface PreviewTarget {
  port: number;
  /** Path (with query) inside the app, always starting with "/". */
  path: string;
}

/** `/preview/5173/src/main.ts?x` → { port: 5173, path: '/src/main.ts?x' }. */
export function parsePreviewUrl(url: string): PreviewTarget | null {
  if (!url.startsWith(PREVIEW_PREFIX)) return null;
  const rest = url.slice(PREVIEW_PREFIX.length);
  const match = /^(\d{1,5})(?=$|[/?#])(.*)$/.exec(rest);
  if (!match) return null;
  const port = Number(match[1]);
  let path = match[2] || '/';
  if (path.startsWith('?')) path = `/${path}`;
  return { port, path };
}

/**
 * Why a port can't be previewed, or null when it can. Below 1024 are system services,
 * Untether's own port would loop through its own auth and UI.
 */
export function previewPortError(
  port: number,
  ownPort: number | null | undefined | ReadonlyArray<number | null | undefined>,
  denied: ReadonlySet<number> = new Set()
): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'port out of range';
  const own = Array.isArray(ownPort) ? ownPort : [ownPort];
  if (own.some((value) => value && port === value)) return "Untether's own port";
  if (denied.has(port)) return 'port denied';
  return null;
}

/** Ports listed in UNTETHER_PREVIEW_DENY_PORTS ("18789,4030"). */
export function parseDeniedPorts(value: string | undefined): Set<number> {
  const ports = new Set<number>();
  for (const part of (value ?? '').split(',')) {
    const port = Number(part.trim());
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}

/** What a ticket or a preview session grants: one port, framed by one Untether origin. */
export interface PreviewGrant {
  port: number;
  /** The Untether origin that asked (from the ticket request's Origin header). */
  parentOrigin: string;
  /** Exact app origin. Grants without it cannot be used by the HTTP/WebSocket proxy. */
  origin?: string;
}

/** Opaque random secrets mapped to grants, in server memory (a restart logs out). */
class GrantStore {
  private entries = new Map<string, PreviewGrant & { expires: number }>();
  constructor(readonly ttlMs: number) {}

  issue(grant: PreviewGrant): string {
    this.prune();
    const secret = randomBytes(32).toString('base64url');
    this.entries.set(secret, { ...grant, expires: Date.now() + this.ttlMs });
    return secret;
  }

  get(secret: string | undefined): PreviewGrant | null {
    if (!secret) return null;
    const entry = this.entries.get(secret);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.entries.delete(secret);
      return null;
    }
    return {
      port: entry.port,
      parentOrigin: entry.parentOrigin,
      ...(entry.origin ? { origin: entry.origin } : {}),
    };
  }

  delete(secret: string): void {
    this.entries.delete(secret);
  }

  private prune() {
    const now = Date.now();
    for (const [secret, entry] of this.entries)
      if (entry.expires < now) this.entries.delete(secret);
  }
}

/** Single-use, 60 s tickets minted by the authenticated main API, redeemed on the preview origin. */
export class PreviewTickets {
  private store: GrantStore;
  constructor(ttlMs = TICKET_TTL_MS) {
    this.store = new GrantStore(ttlMs);
  }
  issue(grant: PreviewGrant): string {
    return this.store.issue(grant);
  }
  /** The grant, once: the ticket is burnt whether or not it was still valid. */
  redeem(ticket: string | undefined): PreviewGrant | null {
    const grant = this.store.get(ticket);
    if (ticket) this.store.delete(ticket);
    return grant;
  }
}

/** Preview-origin sessions behind the per-port cookie (12 h). */
export class PreviewTokens {
  private store: GrantStore;
  constructor(ttlMs = TOKEN_TTL_MS) {
    this.store = new GrantStore(ttlMs);
  }
  issue(grant: PreviewGrant): { token: string; maxAgeSeconds: number } {
    return { token: this.store.issue(grant), maxAgeSeconds: Math.floor(this.store.ttlMs / 1000) };
  }
  /** The session's grant, only for the port it was issued for. */
  verify(token: string | undefined, port: number): PreviewGrant | null {
    const grant = this.store.get(token);
    return grant && grant.port === port ? grant : null;
  }
}

/** `https://host:4020` from an Origin header, or null if it isn't a plain http(s) origin. */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value === 'null') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** One hostname per app: cookies and browser storage must not be shared between apps. */
export function previewAppOrigin(baseOrigin: string, port: number): string | null {
  const normalized = normalizeOrigin(baseOrigin);
  if (!normalized || previewPortError(port, null)) return null;
  const url = new URL(normalized);
  if (['127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'localhost';
  // IP literals cannot have subdomains; Tailscale Serve has no wildcard host/certificate.
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname.endsWith('.ts.net'))
    return null;
  url.hostname = `ut-preview-${port}.${url.hostname}`;
  return url.origin;
}

/** Host is browser-controlled; X-Forwarded-Host is forgeable by a sibling app's scripts. */
function matchesPreviewHost(req: http.IncomingMessage, grant: PreviewGrant): boolean {
  return !!grant.origin && req.headers.host?.toLowerCase() === new URL(grant.origin).host;
}

function isForeignPreviewRequest(req: http.IncomingMessage, grant: PreviewGrant): boolean {
  if (req.headers.origin && req.headers.origin !== grant.origin) return true;
  const site = req.headers['sec-fetch-site'];
  const navigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate';
  if ((site === 'same-site' || site === 'cross-site') && !navigation) return true;
  const referer = normalizeOrigin(req.headers.referer);
  return !!referer && referer !== grant.origin && (!navigation || referer !== grant.parentOrigin);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function isPreviewCookieName(name: string): boolean {
  return name === PREVIEW_COOKIE || name.startsWith(`${PREVIEW_COOKIE}_`);
}

/** The Cookie header without Untether's own preview cookies. */
export function stripPreviewCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split('=', 1)[0].trim();
      return part && !isPreviewCookieName(name);
    });
  return kept.length > 0 ? kept.join('; ') : undefined;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers for the dev server: it sees a plain local browser on localhost:<port>
 * (vite/next reject unknown Host and cross-origin dev requests), never Untether's
 * credentials or the Tailscale identity.
 */
export function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  port: number,
  options: { upgrade?: boolean; isUntetherAuthorization?: (value: string) => boolean } = {}
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const ownHost = headers.host;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (!options.upgrade && HOP_BY_HOP.has(key)) continue;
    if (
      key === 'host' ||
      key === 'cookie' ||
      key.startsWith('x-forwarded-') ||
      key === 'forwarded' ||
      key === 'x-real-ip' ||
      key.startsWith('tailscale-') ||
      key === 'x-untether-local' ||
      key === PREVIEW_SW_HEADER
    ) {
      continue;
    }
    if (key === 'authorization') {
      // The previewed app's own Authorization goes through; an Untether token never does.
      const text = String(value);
      if (!options.isUntetherAuthorization || options.isUntetherAuthorization(text)) continue;
    }
    out[key] = value;
  }
  const local = `localhost:${port}`;
  out.host = local;
  const cookie = stripPreviewCookies(headers.cookie);
  if (cookie) out.cookie = cookie;
  for (const key of ['origin', 'referer'] as const) {
    const value = headers[key];
    if (typeof value !== 'string' || !ownHost) continue;
    try {
      const url = new URL(value);
      if (url.host !== ownHost) continue; // a foreign origin stays visible to the app
      const parsed = parsePreviewUrl(url.pathname + url.search);
      const appPath = parsed && parsed.port === port ? parsed.path : url.pathname + url.search;
      out[key] = key === 'origin' ? `http://${local}` : `http://${local}${appPath}`;
    } catch {
      delete out[key];
    }
  }
  if (!options.upgrade) out['accept-encoding'] = 'identity'; // HTML gets a script injected
  return out;
}

/** Set-Cookie of the previewed app: no Domain, Path under its prefix, never ours. */
export function rewriteSetCookie(cookies: string[], port: number): string[] {
  const prefix = `/preview/${port}`;
  const result: string[] = [];
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(';');
    const name = pair.split('=', 1)[0].trim();
    if (isPreviewCookieName(name)) continue;
    let path = '/';
    const kept: string[] = [];
    for (const attribute of attributes) {
      const key = attribute.split('=', 1)[0].trim().toLowerCase();
      if (key === 'domain') continue;
      if (key === 'path') {
        path = attribute.slice(attribute.indexOf('=') + 1).trim() || '/';
        continue;
      }
      kept.push(attribute.trim());
    }
    const scoped = path.startsWith('/') ? `${prefix}${path === '/' ? '/' : path}` : `${prefix}/`;
    result.push([pair.trim(), `Path=${scoped}`, ...kept].join('; '));
  }
  return result;
}

/** A redirect from the dev server stays inside its preview prefix. */
export function rewriteLocation(location: string, port: number): string {
  const prefix = `/preview/${port}`;
  if (location.startsWith('//')) return location;
  if (location.startsWith('/')) return `${prefix}${location}`;
  try {
    const url = new URL(location);
    const local =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port;
    return local ? `${prefix}${url.pathname}${url.search}${url.hash}` : location;
  } catch {
    return location; // relative ("next") – the browser resolves it under the prefix
  }
}

/** CSP without frame-ancestors (the Untether page must be able to frame the preview). */
export function stripFrameAncestors(csp: string): string {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(\s|$)/i.test(directive))
    .join('; ');
}

/** Response headers from the dev server that may reach the browser, rewritten. */
export function sanitizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
  port: number
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    switch (key) {
      case 'x-frame-options':
      // Would let the app take over more of Untether's origin than its prefix.
      case 'service-worker-allowed':
      case 'clear-site-data':
      case 'strict-transport-security':
      case 'origin-agent-cluster':
        continue;
      case 'content-security-policy':
      case 'content-security-policy-report-only': {
        const csp = stripFrameAncestors(Array.isArray(value) ? value.join(', ') : String(value));
        if (csp) out[key] = csp;
        continue;
      }
      case 'set-cookie':
        out[key] = rewriteSetCookie(Array.isArray(value) ? value : [String(value)], port);
        continue;
      case 'location':
        out[key] = rewriteLocation(String(value), port);
        continue;
      default:
        // The upstream's CORS policy must not expose an authenticated preview to siblings.
        if (key.startsWith('access-control-')) continue;
        out[key] = value;
    }
  }
  return out;
}

/** Injects the preview client script at the start of <head> (or the document). */
export function injectClientScript(html: string, port: number): string {
  const tag = `<script src="/preview/${port}/${PREVIEW_CLIENT_FILE}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length);
  return tag + html;
}

/** First load inside the iframe: install the worker, then load again through it. */
export function bootstrapPage(port: number, path: string, unsupported: string): string {
  const prefix = `/preview/${port}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;color:#888;display:flex;align-items:center;justify-content:center;height:90vh;margin:0;text-align:center;padding:16px}</style></head>
<body><p id="m">…</p><script>
(function(){
  var prefix=${JSON.stringify(prefix)}, path=${JSON.stringify(path)};
  function fail(e){document.getElementById('m').textContent=${JSON.stringify(unsupported)}+(e?' ('+e+')':'');}
  if(!('serviceWorker' in navigator)){fail();return;}
  navigator.serviceWorker.register(prefix+'/${PREVIEW_SW_FILE}',{scope:prefix+'/'}).then(function(reg){
    function go(){location.replace(prefix+path);}
    if(reg.active){go();return;}
    var sw=reg.installing||reg.waiting;
    sw.addEventListener('statechange',function(){if(sw.state==='activated')go();});
  }).catch(function(e){fail(e&&e.message);});
})();
</script></body></html>`;
}

/** Service worker for one preview prefix (served by Untether, not the dev server). */
export function serviceWorkerScript(port: number): string {
  const prefix = `/preview/${port}`;
  return `/* Untether dev-server preview worker for ${prefix}/ */
var PREFIX=${JSON.stringify(prefix)};
self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
function inPrefix(p){return p===PREFIX||p.indexOf(PREFIX+'/')===0;}
async function forward(req,url,redirect){
  var headers=new Headers(req.headers);headers.set('${PREVIEW_SW_HEADER}','1');
  var init={method:req.method,headers:headers,credentials:'same-origin',redirect:redirect};
  if(req.method!=='GET'&&req.method!=='HEAD')init.body=await req.arrayBuffer();
  return fetch(url,init);
}
self.addEventListener('fetch',function(e){
  var req=e.request,url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(inPrefix(url.pathname)){
    if(req.mode==='navigate')e.respondWith(forward(req,url.href,'manual'));
    return;
  }
  var target=self.location.origin+PREFIX+url.pathname+url.search;
  if(req.mode==='navigate'){e.respondWith(Response.redirect(target,302));return;}
  // Same request URL for the page (no second copy of a module), body from the prefix.
  e.respondWith(forward(req,target,'follow').then(function(res){
    return new Response(res.body,{status:res.status,statusText:res.statusText,headers:res.headers});
  }));
});
`;
}

/**
 * Script injected into proxied HTML: HMR sockets, app-relative URL, address bar updates.
 * The Untether page is another origin now: location reports go to `parentOrigin` only,
 * and back/forward arrive as messages from it (it can't touch the frame's history).
 */
export function clientScript(port: number, parentOrigin: string): string {
  const prefix = `/preview/${port}`;
  return `(function(){
var PREFIX=${JSON.stringify(prefix)},PORT=${JSON.stringify(String(port))},PARENT=${JSON.stringify(parentOrigin)};
try{document.cookie='${PREVIEW_PORT_COOKIE}='+PORT+'; Path=/; SameSite=Strict'+(location.protocol==='https:'?'; Secure':'');}catch(e){}
var p=location.pathname;
if(p===PREFIX||p.indexOf(PREFIX+'/')===0){try{history.replaceState(history.state,'',(p.slice(PREFIX.length)||'/')+location.search+location.hash);}catch(e){}}
var W=window.WebSocket;
function fix(u){
  var x;try{x=new URL(String(u),location.href);}catch(e){return u;}
  var local=(x.hostname==='localhost'||x.hostname==='127.0.0.1'||x.hostname==='[::1]'||x.hostname===location.hostname)&&x.port===PORT;
  if(x.host!==location.host&&!local)return u;
  if(local){x.host=location.host;}
  x.protocol=location.protocol==='https:'?'wss:':'ws:';
  if(!(x.pathname===PREFIX||x.pathname.indexOf(PREFIX+'/')===0))x.pathname=PREFIX+x.pathname;
  return x.href;
}
function PW(u,p){return p===undefined?new W(fix(u)):new W(fix(u),p);}
PW.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){PW[k]=W[k];});
window.WebSocket=PW;
function report(){try{if(parent!==window)parent.postMessage({type:'ut-preview-location',port:Number(PORT),path:location.pathname+location.search+location.hash,title:document.title},PARENT);}catch(e){}}
['pushState','replaceState'].forEach(function(k){var f=history[k];history[k]=function(){var r=f.apply(this,arguments);report();return r;};});
addEventListener('popstate',report);addEventListener('hashchange',report);addEventListener('load',report);report();
addEventListener('message',function(e){
  if(e.origin!==PARENT||e.source!==parent)return;
  var d=e.data;if(!d||d.type!=='ut-preview-history')return;
  if(d.direction==='back')history.back();else if(d.direction==='forward')history.forward();
});
})();
`;
}

/** Address of the dev server: 127.0.0.1 or ::1, whichever is listening (cached briefly). */
const hostCache = new Map<number, { host: string; at: number }>();
function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
export async function resolveLoopbackHost(port: number): Promise<string | null> {
  const cached = hostCache.get(port);
  if (cached && Date.now() - cached.at < 10_000) return cached.host;
  for (const host of ['127.0.0.1', '::1']) {
    if (await probe(host, port)) {
      hostCache.set(port, { host, at: Date.now() });
      return host;
    }
  }
  hostCache.delete(port);
  return null;
}

/**
 * Whether the server on this port speaks TLS. Some local apps only serve https (an OAuth or
 * banking callback that requires it) and answer plain http with a redirect to
 * `https://localhost:<port>/`, which the preview maps back onto itself: a redirect loop.
 * Those are reached over TLS instead. The certificate isn't checked: the peer is a loopback
 * address on this machine, usually with a self-signed or mkcert certificate.
 */
const tlsCache = new Map<number, { secure: boolean; at: number }>();
function probeTls(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: 'localhost',
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('secureConnect', () => done(true));
    socket.once('error', () => done(false));
  });
}
export async function upstreamUsesTls(host: string, port: number): Promise<boolean> {
  const cached = tlsCache.get(port);
  if (cached && Date.now() - cached.at < 60_000) return cached.secure;
  const secure = await probeTls(host, port);
  tlsCache.set(port, { secure, at: Date.now() });
  return secure;
}
export function forgetUpstreamTls(port: number): void {
  tlsCache.delete(port);
}

/**
 * Every Untether response carries this header (main and preview origins). A port that
 * answers with it is another Untether server (a QA one on 4030, an older one…) and is
 * never previewed: its UI could otherwise expose another server through the preview's
 * credentials (2026-10-03).
 */
export const UNTETHER_SERVER_HEADER = 'x-untether-server';

export interface PreviewProxyOptions {
  /** Untether's own listening ports (main and preview): never previewable. */
  getOwnPorts: () => ReadonlyArray<number | null | undefined>;
  /** True when an Authorization value is an Untether credential (never forwarded). */
  isUntetherAuthorization?: (value: string) => boolean;
  deniedPorts?: ReadonlySet<number>;
  tokens?: PreviewTokens;
  tickets?: PreviewTickets;
  unsupportedMessage?: string;
  /** A port turned out to be an Untether server (it answered with UNTETHER_SERVER_HEADER). */
  onUntetherPort?: (port: number) => void;
}

/** `/preview/<port>/…` with the same port, or the app root for anything else. */
export function safeNextPath(next: unknown, port: number): string {
  const fallback = `/preview/${port}/`;
  if (typeof next !== 'string' || /[\\\s]/.test(next) || next.startsWith('//')) return fallback;
  const target = parsePreviewUrl(next);
  return target && target.port === port ? next : fallback;
}

/** Only the Untether origin that asked for the preview may frame it. */
export function frameAncestors(parentOrigin: string): string {
  return `frame-ancestors ${parentOrigin}`;
}

/**
 * The proxy for the preview listener. Every handler here runs on the preview origin only;
 * nothing on the main origin serves previews.
 */
export function createPreviewProxy(options: PreviewProxyOptions) {
  const tokens = options.tokens ?? new PreviewTokens();
  const tickets = options.tickets ?? new PreviewTickets();
  const denied = options.deniedPorts ?? new Set<number>();
  /** Ports found to be other Untether servers (this run; found again after a restart). */
  const untetherPorts = new Set<number>();
  const lastLogged = new Map<string, number>();
  const noteUntetherPort = (port: number) => {
    if (untetherPorts.has(port)) return;
    untetherPorts.add(port);
    logger.log(`port ${port} is an Untether server: never previewed`);
    options.onUntetherPort?.(port);
  };

  const logAccess = (req: http.IncomingMessage, port: number, kind: string) => {
    const key = `${kind}:${port}`;
    const now = Date.now();
    if ((lastLogged.get(key) ?? 0) > now - 60_000) return;
    lastLogged.set(key, now);
    logger.log(`preview ${kind} to port ${port} from ${req.socket.remoteAddress ?? '?'}`);
  };

  /** The preview session for this port, from its own cookie only (no main-origin auth). */
  const sessionFor = (req: http.IncomingMessage, port: number): PreviewGrant | null => {
    const grant = tokens.verify(readCookie(req.headers.cookie, previewCookieName(port)), port);
    return grant && matchesPreviewHost(req, grant) && !isForeignPreviewRequest(req, grant)
      ? grant
      : null;
  };

  const check = (port: number) =>
    previewPortError(port, options.getOwnPorts(), denied) ??
    (untetherPorts.has(port) ? 'another Untether server' : null);

  /** Main API side (already authenticated): a ticket for one port, framed by `parentOrigin`. */
  function issueTicket(port: number, parentOrigin: string, origin: string): string {
    return tickets.issue({ port, parentOrigin, origin });
  }

  /** `GET /__ut_preview_login?ticket=…&next=/preview/<port>/…` on the preview origin. */
  function handleLogin(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
    const grant = tickets.redeem(ticket);
    if (!grant || check(grant.port) || !matchesPreviewHost(req, grant)) {
      res.status(401).type('text/plain').send('This preview link has expired. Open it again.');
      return;
    }
    const { token, maxAgeSeconds } = tokens.issue(grant);
    const hostname = new URL(grant.origin as string).hostname;
    const secure =
      req.secure || req.headers['x-forwarded-proto'] === 'https' || hostname.endsWith('.localhost');
    // Isolated hosts can be cross-site to their parent (including *.localhost). Cookie
    // credentials remain host-only; sessionFor enforces Origin/Fetch Metadata for CSRF.
    const sameSite = secure ? 'None' : 'Strict';
    res.setHeader(
      'Set-Cookie',
      `${previewCookieName(grant.port)}=${token}; Path=/preview/${grant.port}/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=${sameSite}${secure ? '; Secure' : ''}`
    );
    res.redirect(302, safeNextPath(req.query.next, grant.port));
  }

  /** Express middleware for `/preview/...`; anything else goes to next(). */
  async function handleRequest(req: Request, res: Response, next: NextFunction) {
    const target = parsePreviewUrl(req.originalUrl ?? req.url);
    if (!target) {
      if (req.originalUrl.startsWith(PREVIEW_PREFIX)) {
        res.status(404).type('text/plain').send('Not a preview URL');
        return;
      }
      return next();
    }
    const portError = check(target.port);
    if (portError) {
      res.status(403).type('text/plain').send(`Preview not allowed: ${portError}`);
      return;
    }
    const grant = sessionFor(req, target.port);
    if (!grant) {
      res.status(401).type('text/plain').send('Open this preview from Untether again.');
      return;
    }
    logAccess(req, target.port, 'http');
    const ancestors = frameAncestors(grant.parentOrigin);

    const pathOnly = target.path.split('?', 1)[0];
    if (pathOnly === `/${PREVIEW_SW_FILE}` || pathOnly === `/${PREVIEW_CLIENT_FILE}`) {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(
        pathOnly === `/${PREVIEW_SW_FILE}`
          ? serviceWorkerScript(target.port)
          : clientScript(target.port, grant.parentOrigin)
      );
      return;
    }

    const isNavigation =
      req.method === 'GET' &&
      !req.headers[PREVIEW_SW_HEADER] &&
      (req.headers['sec-fetch-mode'] === 'navigate' ||
        (!req.headers['sec-fetch-mode'] && String(req.headers.accept ?? '').includes('text/html')));
    if (isNavigation) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', ancestors);
      res.send(
        bootstrapPage(
          target.port,
          target.path,
          options.unsupportedMessage ?? 'This browser cannot show the preview here.'
        )
      );
      return;
    }

    const host = await resolveLoopbackHost(target.port);
    if (!host) {
      res
        .status(502)
        .type('text/plain')
        .send(`Nothing is listening on port ${target.port} on this Mac.`);
      return;
    }

    const secure = await upstreamUsesTls(host, target.port);
    const upstream = (secure ? https : http).request({
      host,
      port: target.port,
      ...(secure ? { servername: 'localhost', rejectUnauthorized: false } : {}),
      method: req.method,
      path: target.path,
      headers: buildUpstreamHeaders(req.headers, target.port, {
        isUntetherAuthorization: options.isUntetherAuthorization,
      }),
    });
    upstream.on('response', (upstreamRes) => {
      if (upstreamRes.headers[UNTETHER_SERVER_HEADER]) {
        noteUntetherPort(target.port);
        upstreamRes.resume();
        upstream.destroy();
        res.status(403).type('text/plain').send('Preview not allowed: another Untether server');
        return;
      }
      const headers = sanitizeResponseHeaders(upstreamRes.headers, target.port);
      // The app's own CSP (minus frame-ancestors) stays; ours is a second, separate policy.
      const cspHeader: string = 'content-security-policy'; // repeated header: string[]
      const appCsp = headers[cspHeader];
      headers[cspHeader] = appCsp ? [String(appCsp), ancestors] : ancestors;
      const type = String(upstreamRes.headers['content-type'] ?? '');
      const encoding = String(upstreamRes.headers['content-encoding'] ?? 'identity');
      if (type.includes('text/html') && encoding === 'identity' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const html = injectClientScript(Buffer.concat(chunks).toString('utf8'), target.port);
          delete headers['content-length'];
          delete headers.etag; // the body differs from the dev server's
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          res.end(html);
        });
        upstreamRes.on('error', () => res.destroy());
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', (error) => {
      forgetUpstreamTls(target.port); // the app may have restarted with or without TLS
      logger.debug(`preview upstream error on port ${target.port}: ${error.message}`);
      if (!res.headersSent) {
        res.status(502).type('text/plain').send('The dev server did not answer.');
      } else {
        res.destroy();
      }
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  /**
   * WebSocket upgrade on the preview listener (HMR). Anything that isn't `/preview/<port>/`
   * with that port's session cookie is refused before connecting anywhere.
   */
  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const target = parsePreviewUrl(req.url ?? '');
    if (!target) {
      reject('404 Not Found');
      return;
    }
    if (check(target.port)) {
      reject('403 Forbidden');
      return;
    }
    if (!sessionFor(req, target.port)) {
      reject('401 Unauthorized');
      return;
    }
    logAccess(req, target.port, 'websocket');
    const host = await resolveLoopbackHost(target.port);
    if (!host) {
      reject('502 Bad Gateway');
      return;
    }
    const headers = buildUpstreamHeaders(req.headers, target.port, {
      upgrade: true,
      isUntetherAuthorization: options.isUntetherAuthorization,
    });
    const secure = await upstreamUsesTls(host, target.port);
    const onConnect = () => {
      let request = `${req.method ?? 'GET'} ${target.path} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          request += `${name}: ${String(item).replace(/[\r\n]/g, '')}\r\n`;
        }
      }
      upstream.write(`${request}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    const upstream: net.Socket = secure
      ? tls.connect(
          { host, port: target.port, servername: 'localhost', rejectUnauthorized: false },
          onConnect
        )
      : net.connect({ host, port: target.port }, onConnect);
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  }

  /**
   * A full load that lost its prefix (reload after the page moved its URL to `/about`, a
   * plain link, or the same in the "Open in Safari" tab) goes back under the last port.
   */
  function redirectStrayLoad(req: Request, res: Response, next: NextFunction) {
    const dest = req.headers['sec-fetch-dest'];
    if (
      req.method !== 'GET' ||
      (dest !== 'iframe' && dest !== 'document') ||
      req.path.startsWith(PREVIEW_PREFIX)
    ) {
      return next();
    }
    const port = Number(readCookie(req.headers.cookie, PREVIEW_PORT_COOKIE));
    if (check(port)) return next();
    res.redirect(302, `/preview/${port}${req.originalUrl}`);
  }

  return {
    handleLogin,
    handleRequest,
    handleUpgrade,
    redirectStrayLoad,
    issueTicket,
    tokens,
    /** Why this port can't be previewed (range, Untether's own or another, denied), or null. */
    portError: check,
    /** Remember a port found to be an Untether server (health check, announcement check). */
    noteUntetherPort,
  };
}

export type PreviewProxy = ReturnType<typeof createPreviewProxy>;
