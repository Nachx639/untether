import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  AI_REPLY_KEEP,
  askForJson,
  extractJsonObject,
  mendJsonStrings,
  saveUnreadableReply,
} from './ai-json-reply.js';

const verdict = (value: unknown) => {
  const data = value as { verdict?: unknown; summary?: unknown };
  return typeof data.verdict === 'string' && typeof data.summary === 'string'
    ? { verdict: data.verdict, summary: data.summary }
    : null;
};

// The reply of 2026-10-25 (task 2408ebef) that came back as "not the JSON asked for".
const answer =
  '{"verdict":"ok","summary":"El arreglo de compartir pantalla es coherente","issues":[{"file":"desktop/src/preload.ts","severity":"low","category":"nit","what":"Un comentario {sobra}"}]}';

describe('extractJsonObject', () => {
  it('reads the object with text, a fence or a brace after it', () => {
    for (const reply of [
      answer,
      `${answer}\n\nEspero que sirva. Si hay dudas {pregunta}.`,
      `Aquí va:\n\`\`\`json\n${answer}\n\`\`\`\nNotas: nada más }`,
      `\`\`\`\n${answer}\n\`\`\``,
    ]) {
      expect(extractJsonObject(reply, verdict)).toEqual({
        ok: true,
        value: { verdict: 'ok', summary: 'El arreglo de compartir pantalla es coherente' },
      });
    }
  });

  it('keeps typographic quotes, accents and ``` inside strings', () => {
    const reply = '{"verdict":"ok","summary":"«Añadir» “pantalla” — ñandú ```x``` ✓"}';
    expect(extractJsonObject(reply, verdict)).toMatchObject({
      ok: true,
      value: { summary: '«Añadir» “pantalla” — ñandú ```x``` ✓' },
    });
  });

  it('mends raw line breaks and unescaped quotes inside strings', () => {
    const reply = '{"verdict":"ok","summary":"usa "share" en\nla ventana"}';
    expect(extractJsonObject(reply, verdict)).toMatchObject({
      ok: true,
      value: { summary: 'usa "share" en\nla ventana' },
    });
    expect(mendJsonStrings('{"a":"x\t"}')).toBe('{"a":"x\\t"}');
  });

  it('says a reply cut short is cut, and never mends it into an answer', () => {
    const cut = answer.slice(0, 140);
    expect(extractJsonObject(cut, verdict)).toMatchObject({ ok: false, problem: 'truncated' });
  });

  it('takes the first of two objects, unless they must agree', () => {
    const two = `${answer}\n{"verdict":"concerns","summary":"otra"}`;
    expect(extractJsonObject(two, verdict)).toMatchObject({ ok: true, value: { verdict: 'ok' } });
    expect(extractJsonObject(two, verdict, { unique: true })).toMatchObject({
      ok: false,
      problem: 'ambiguous',
    });
    expect(extractJsonObject(`${answer}\n${answer}`, verdict, { unique: true })).toMatchObject({
      ok: true,
    });
    // An example object before the answer is skipped: it is not the shape asked for.
    expect(extractJsonObject(`Formato {"a":1}. Respuesta: ${answer}`, verdict)).toMatchObject({
      ok: true,
      value: { verdict: 'ok' },
    });
  });

  it('names what is wrong otherwise', () => {
    expect(extractJsonObject('Looks fine.', verdict)).toMatchObject({ problem: 'no-json' });
    expect(extractJsonObject('{"verdict":1}', verdict)).toMatchObject({ problem: 'wrong-shape' });
    expect(extractJsonObject('{verdict: ok}', verdict)).toMatchObject({ problem: 'invalid' });
  });
});

describe('askForJson', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-ai-reply-'));
  });
  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('asks again once, saying what was wrong, and keeps the unreadable reply whole', async () => {
    const asked: string[] = [];
    const cut = answer.slice(0, 140);
    const replies = [cut, answer];
    const read = await askForJson({
      ask: async (question) => {
        asked.push(question);
        return replies.shift() ?? null;
      },
      question: 'Q',
      accept: verdict,
      label: 'task-review',
      shorterHint: 'at most 3 issues.',
      replyDir: dir,
    });
    expect(read).toMatchObject({ ok: true, value: { verdict: 'ok' } });
    expect(asked[0]).toBe('Q');
    expect(asked[1]).toContain('YOUR PREVIOUS REPLY COULD NOT BE READ (the JSON object was cut');
    expect(asked[1]).toContain('It was cut off: at most 3 issues.');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toContain(cut);
    expect(fs.statSync(path.join(dir, files[0])).mode & 0o777).toBe(0o600);
  });

  it('gives up after two unreadable replies, naming why and where they are', async () => {
    const long = `Looks fine. ${'x'.repeat(500)}`;
    const read = await askForJson({
      ask: async () => long,
      question: 'Q',
      accept: verdict,
      label: 'task-review',
      replyDir: dir,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.noAnswer).toBe(false);
    expect(read.reason).toContain(
      'not the JSON asked for (no JSON object in the reply, asked twice'
    );
    expect(read.reason).toContain(dir);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toContain(long);
  });

  it('does not ask again when there was no answer at all', async () => {
    let calls = 0;
    const read = await askForJson({
      ask: async () => {
        calls++;
        return null;
      },
      question: 'Q',
      accept: verdict,
      label: 'x',
      replyDir: dir,
    });
    expect(read).toMatchObject({ ok: false, noAnswer: true });
    expect(calls).toBe(1);
  });

  it('keeps only the newest replies', () => {
    for (let i = 0; i < AI_REPLY_KEEP + 5; i++) {
      saveUnreadableReply(dir, 'x', 1, 'p', `r${i}`, new Date(Date.UTC(2026, 9, 25, 0, 0, i)));
    }
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(AI_REPLY_KEEP);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toContain('r5');
  });
});
