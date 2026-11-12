/**
 * JSON body parsers, sized per route.
 *
 * 2026-10-20: one `express.json({ limit: '10mb' })` ran in front of every route, before the
 * login check: anyone who could reach the port made the server buffer and parse 10 MB per
 * request, and POST /api/logs/client (a handful of log lines) accepted 10 MB bodies only to
 * answer 413 afterwards. Now the routes that take small bodies (the login routes, the client
 * logs) get a small parser in front, and the 10 MB one runs only after the auth middleware,
 * where pasted text and big session inputs still need it.
 */
import express, { type RequestHandler } from 'express';

/** Small bodies: the login routes and the client logs (routes/logs.ts MAX_CLIENT_LOG_BYTES). */
export const SMALL_JSON_LIMIT = '256kb';
/** Signed-in API requests (session input, pasted text …). */
export const LARGE_JSON_LIMIT = '10mb';
/** Mounted before the auth middleware with SMALL_JSON_LIMIT. */
export const SMALL_JSON_PATHS = ['/api/auth', '/api/logs/client'];

/** In front of the auth middleware: only the small-body routes are parsed there. */
export function smallJsonParser(): RequestHandler {
  return express.json({ limit: SMALL_JSON_LIMIT });
}

/**
 * After the auth middleware: /api requests (signed in by then) up to LARGE_JSON_LIMIT, the
 * rest (share pages, previews' own routes) up to SMALL_JSON_LIMIT. A body a parser in front
 * already read is not read again (body-parser marks it).
 */
export function apiJsonParsers(): { api: RequestHandler; other: RequestHandler } {
  return {
    api: express.json({ limit: LARGE_JSON_LIMIT }),
    other: express.json({ limit: SMALL_JSON_LIMIT }),
  };
}
