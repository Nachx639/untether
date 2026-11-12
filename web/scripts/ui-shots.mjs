#!/usr/bin/env node
// Screenshots of the real interface, from the twin (scripts/gemelo.sh run --rich): never the real
// server, the Mac app or ~/.untether. Fixed date and time, no animations, same fictitious data.
//
//   node web/scripts/ui-shots.mjs [--look <id>] [--style <id>] [--theme light|dark|system]
//     [--accent <id>] [--locale es|en] [--out <dir>] [--browsers webkit,chromium] [--views mobile,desktop,task,…]
//     [--gallery] [--check-untouchables] [--measure-scroll] [--audit-layout] [--safe-area]
//
// Views: mobile (390x844, session list), desktop (1440x900, compact sidebar next to a session),
// task (390x844, the sheet of a task), session (390x844, a session), chat (1440x900, a session in
// chat mode), chat-wide-1440, -2000 and -3440 (an agent's conversation with long text, wide code, a table and an
// attached image at the default "Chat width", full; chat-comfortable-* is the 720 px choice), mobile-projects, -320 and -440 and desktop-projects (the project headers, with a crop
// of each), mobile-320 and mobile-wide (the list on a narrow and a wide phone), mobile-folded, -320 and -440 and desktop-folded (one project folded, the others open), settings and create (390x844, Settings and the new-session form), settings-desktop
// and create-desktop (the same at 1440x900), mobile-queue, -320 and -440 (a project's queued tasks). PNGs go to --out, by default $TMPDIR/ut-shots, named
// <browser>-<view>-<style>.png. To compare two folders: ui-shots-diff.mjs.
//
// --style takes anything the app can show today: a theme (light, dark, system) or an accent
// (accent-themes.ts). --look takes an interface style of shared/looks.ts; a style that admits both
// modes is captured in light and in dark unless --theme says one. appearance (390x844, the style
// picker) is one more view, on request: --views appearance. --gallery captures the phone list of
// every style and every mode and joins them in <out>/gallery.png. --check-untouchables compares the
// computed style of logos, 3D icons and the terminal with Original, in the --look given.
//
// --locale en (2026-11-11, the README's captures) gives the interface and the twin's data in
// English (scripts/gemelo-seed/locales/en.mjs); the default is Spanish. The long conversation of
// the chat-wide-* and chat-comfortable-* views and the fixtures of ui-shots-coverage.mjs are
// written in Spanish only.
//
// Each run gets its own HOME and a free port, so it never collides with another task's twin, and
// gemelo.sh removes the twin on any exit.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
//
// The tool is in ui-shots/: the views in a registry (views/, one file per group of views: a new
// view is an entry in its group's file), the twin's start (twin.mjs), the captures (capture.mjs),
// the audits (audit.mjs) and the gallery (gallery.mjs).
import { fileURLToPath } from 'node:url';
import { inside } from './ui-shots/capture.mjs';
import { captures, parseArgs } from './ui-shots/options.mjs';
import { outside } from './ui-shots/twin.mjs';

const argv = process.argv.slice(2);
const options = parseArgs(argv);
captures(options); // a bad --style or --look fails here, before the twin starts
if (options.inner) await inside(options);
else await outside(fileURLToPath(import.meta.url), argv, options);
