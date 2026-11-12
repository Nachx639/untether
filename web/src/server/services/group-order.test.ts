import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createProjectRoutes } from '../routes/projects.js';
import {
  COLLAPSED_OTHERS,
  GROUP_ORDER_MAX,
  GroupOrderStore,
  SESSION_ORDER_MAX,
} from './group-order.js';
import type { ProjectSettingsStore } from './project-settings.js';
import type { TaskCommands } from './task-commands.js';

// 2026-11-07: the home's group order the user drags, the same on the phone and every browser.
describe('group order', () => {
  let tmp: string;
  let file: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-group-order-'));
    file = path.join(tmp, 'group-order.json');
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('keeps the order on disk, as the client compares folders, each once', () => {
    const store = new GroupOrderStore(file);
    expect(store.get()).toEqual([]);
    expect(store.set(['/Users/me/b/', '/private/var/x', '/Users/me/a', '/Users/me/b'])).toEqual([
      '/Users/me/b',
      '/var/x',
      '/Users/me/a',
    ]);
    expect(new GroupOrderStore(file).get()).toEqual(['/Users/me/b', '/var/x', '/Users/me/a']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      order: ['/Users/me/b', '/var/x', '/Users/me/a'],
      sessions: [],
      collapsed: [],
    });
  });

  // 2026-11-10, user request: fold the projects so they do not all show open. What is folded
  // survives a server restart (a new store on the same file).
  it('keeps the folded groups beside the orders, "Otras" among them, each once', () => {
    const store = new GroupOrderStore(file);
    store.set(['/p/a']);
    store.setSessions(['s1']);
    expect(store.getCollapsed()).toEqual([]);
    expect(store.setCollapsed(['/p/b/', COLLAPSED_OTHERS, '/private/p/c', '/p/b'])).toEqual([
      '/p/b',
      '/p/c',
      COLLAPSED_OTHERS,
    ]);
    const again = new GroupOrderStore(file);
    expect(again.getCollapsed()).toEqual(['/p/b', '/p/c', COLLAPSED_OTHERS]);
    // Each list is saved without touching the others.
    expect(again.get()).toEqual(['/p/a']);
    expect(again.getSessions()).toEqual(['s1']);
    again.set(['/p/z']);
    again.setSessions(['s2']);
    expect(new GroupOrderStore(file).getCollapsed()).toEqual(['/p/b', '/p/c', COLLAPSED_OTHERS]);
    for (const bad of [
      null,
      'x',
      [1],
      ['relative'],
      ['others'],
      Array(GROUP_ORDER_MAX + 1).fill('/a'),
    ]) {
      expect(() => store.setCollapsed(bad)).toThrow();
    }
    expect(store.getCollapsed()).toEqual(['/p/b', '/p/c', COLLAPSED_OTHERS]);
    // Unfolding everything is saved too.
    expect(store.setCollapsed([])).toEqual([]);
    expect(new GroupOrderStore(file).getCollapsed()).toEqual([]);
  });

  // A file written before the folded groups existed: the orders are kept, nothing is folded.
  it('reads a file without folded groups', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, order: ['/p/a'], sessions: ['s1'] }));
    const store = new GroupOrderStore(file);
    expect(store.get()).toEqual(['/p/a']);
    expect(store.getCollapsed()).toEqual([]);
  });

  // 2026-11-07: the user dragged sidebar rows up and down to reorder them inside their group.
  it('keeps the session order beside the group order, each id once', () => {
    const store = new GroupOrderStore(file);
    store.set(['/p/a']);
    expect(store.setSessions(['s2', 'abc-123', 's2', 's1'])).toEqual(['s2', 'abc-123', 's1']);
    const again = new GroupOrderStore(file);
    expect(again.getSessions()).toEqual(['s2', 'abc-123', 's1']);
    // Each list is saved without touching the other.
    expect(again.get()).toEqual(['/p/a']);
    again.set(['/p/b']);
    expect(new GroupOrderStore(file).getSessions()).toEqual(['s2', 'abc-123', 's1']);
    for (const bad of [null, 'x', [1], ['../x'], ['a b'], Array(SESSION_ORDER_MAX + 1).fill('a')]) {
      expect(() => store.setSessions(bad)).toThrow();
    }
    expect(store.getSessions()).toEqual(['s2', 'abc-123', 's1']);
  });

  it('refuses what is not a list of absolute folders', () => {
    const store = new GroupOrderStore(file);
    for (const bad of [
      null,
      'x',
      ['relative'],
      [1],
      ['/a\nb'],
      Array(GROUP_ORDER_MAX + 1).fill('/a'),
    ]) {
      expect(() => store.set(bad)).toThrow();
    }
    expect(store.get()).toEqual([]);
  });

  it('a file it cannot read is copied aside and counts as no order', () => {
    fs.writeFileSync(file, '{ not json');
    const errors: string[] = [];
    expect(new GroupOrderStore(file, (message) => errors.push(message)).get()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(fs.readdirSync(tmp).some((name) => name.startsWith('group-order.json.bad-'))).toBe(true);
  });

  // Rule 2b (2026-10-20): a renamed project folder must not lose what was kept under its name.
  it('follows moved project folders (and folders inside them)', () => {
    const store = new GroupOrderStore(file);
    store.set(['/p/new-name', '/p/toolshed', '/p/toolshed/sub', '/p/other']);
    expect(store.projectsMoved([{ from: '/p/toolshed', to: '/p/bakery' }])).toBe(2);
    expect(new GroupOrderStore(file).get()).toEqual([
      '/p/new-name',
      '/p/bakery',
      '/p/bakery/sub',
      '/p/other',
    ]);
    // Moving onto a folder already in it keeps one.
    expect(store.projectsMoved([{ from: '/p/other', to: '/p/new-name' }])).toBe(1);
    expect(store.get()).toEqual(['/p/new-name', '/p/bakery', '/p/bakery/sub']);
    expect(store.projectsMoved([{ from: '/q', to: '/r' }])).toBe(0);
  });

  // Rule 2b: a folded project stays folded under its new name ("Otras" has no folder to move).
  it('keeps a moved project folded', () => {
    const store = new GroupOrderStore(file);
    store.setCollapsed(['/p/toolshed', COLLAPSED_OTHERS]);
    expect(store.projectsMoved([{ from: '/p/toolshed', to: '/p/bakery' }])).toBe(1);
    expect(new GroupOrderStore(file).getCollapsed()).toEqual(['/p/bakery', COLLAPSED_OTHERS]);
  });

  describe('PUT /api/projects/group-order', () => {
    let authMethod: string;
    let app: express.Express;
    let store: GroupOrderStore;

    beforeEach(() => {
      authMethod = 'password';
      store = new GroupOrderStore(file);
      app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as { authMethod?: string }).authMethod = authMethod;
        next();
      });
      app.use(
        '/api',
        createProjectRoutes({
          settings: {} as ProjectSettingsStore,
          scheduler: () => null,
          commands: {} as TaskCommands,
          groupOrder: store,
        })
      );
    });

    it('saves the signed-in app’s order', async () => {
      const response = await request(app)
        .put('/api/projects/group-order')
        .send({ order: ['/p/b', '/p/a/'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ order: ['/p/b', '/p/a'] });
      expect(store.get()).toEqual(['/p/b', '/p/a']);
    });

    it('refuses a bad order (400) and anyone but the signed-in app (403)', async () => {
      const bad = await request(app)
        .put('/api/projects/group-order')
        .send({ order: ['relative'] });
      expect(bad.status).toBe(400);
      authMethod = 'local-bypass';
      const foreign = await request(app)
        .put('/api/projects/group-order')
        .send({ order: ['/p/a'] });
      expect(foreign.status).toBe(403);
      expect(store.get()).toEqual([]);
    });

    it('PUT /api/projects/session-order saves the sessions’ order, the signed-in app only', async () => {
      const response = await request(app)
        .put('/api/projects/session-order')
        .send({ order: ['s2', 's1'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ order: ['s2', 's1'] });
      expect(store.getSessions()).toEqual(['s2', 's1']);
      const bad = await request(app)
        .put('/api/projects/session-order')
        .send({ order: ['/not/an/id'] });
      expect(bad.status).toBe(400);
      authMethod = 'local-bypass';
      const foreign = await request(app)
        .put('/api/projects/session-order')
        .send({ order: ['s1'] });
      expect(foreign.status).toBe(403);
      expect(store.getSessions()).toEqual(['s2', 's1']);
    });

    it('PUT /api/projects/collapsed-groups saves the folded groups, the signed-in app only', async () => {
      const response = await request(app)
        .put('/api/projects/collapsed-groups')
        .send({ collapsed: ['/p/a/', COLLAPSED_OTHERS] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ collapsed: ['/p/a', COLLAPSED_OTHERS] });
      expect(store.getCollapsed()).toEqual(['/p/a', COLLAPSED_OTHERS]);
      const bad = await request(app)
        .put('/api/projects/collapsed-groups')
        .send({ collapsed: ['relative'] });
      expect(bad.status).toBe(400);
      authMethod = 'local-bypass';
      const foreign = await request(app)
        .put('/api/projects/collapsed-groups')
        .send({ collapsed: [] });
      expect(foreign.status).toBe(403);
      expect(store.getCollapsed()).toEqual(['/p/a', COLLAPSED_OTHERS]);
    });
  });
});
