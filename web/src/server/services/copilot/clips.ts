/**
 * Interjection clips (2026-10-13, user report: «le cuesta un poco de tiempo… interjecciones, tipo
 * voy a ello»). Pre-rendered once with the same Kokoro voice and sent to the page on connect, so
 * playing one needs no TTS call and no network round trip.
 *
 * Categories, all picked by the copilot once the transcript is known (2026-10-13, judges: the page
 * used to play «A ver» before knowing what was said, so «para el login» got «Bueno, a ver.» first):
 *   question / status / order / risky / neutral  only on turns that wait for the model and only
 *            for three words or more; fast paths («para», «sí», «espera», «confirmo») get none
 *   hold     once per turn, when the model has written nothing ~1.5 s after the first clip ended
 *            (2 s after the utterance when there was none)
 *
 * No clip ever claims something was done, and the risky pool has nothing that sounds like doing
 * it (the answer will be «di confirmo»). «Vale» / «Venga» are left out on purpose: they are bare
 * «sí» words, and an echo of one picked up by the mic would answer an open menu.
 */
export type ClipCat = 'neutral' | 'question' | 'status' | 'order' | 'risky' | 'hold';

export interface Clip {
  id: string;
  cat: ClipCat;
  lang: 'es' | 'en';
  text: string;
  /**
   * What the clip sounds like («a ver», «mirar», «voy»…): never the same family as the last two
   * clips heard (2026-10-13, naturalness judge: «A ver / Vamos a ver / Pues a ver / Bueno, a ver»
   * rotated the text but not the tic).
   */
  fam: string;
}

// Each text was rendered with Kokoro and transcribed back with whisper (2026-10-13). Out: «Mm.»,
// «Mmm…», «Ajá.», «Hmm.», «Eh…» (spelled or garbled: «También me llamé», «Se eno»), «Ya voy.»
// («Chaboy»), «Ya miro.» («Giammiro»), «Ahora lo miro.» («Ahora los mires»). Out on purpose:
// «Marchando.» (a waiter's word, a joke when repeated), «Enseguida.» / «Ahora mismo.» (promise speed,
// then the answer is late), «Sigo mirando.» (machine-like), «Un segundo, que lo miro.» and «Pues
// déjame mirar.», «Ahora se lo digo.», «Dame un segundo.», «Un segundito.» (1.1–1.6 s, as long as
// some answers). Every clip is 0.5–1.0 s once trimmed.
const ES: [string, ClipCat, string, string][] = [
  ['n-aver', 'neutral', 'A ver.', 'aver'],
  ['n-yalomiro', 'neutral', 'Ya lo miro.', 'mirar'],
  ['n-vamosaver', 'neutral', 'Vamos a ver.', 'aver'],
  ['q-dejamever', 'question', 'Déjame ver.', 'ver'],
  ['q-yalomiro', 'question', 'Ya lo miro.', 'mirar'],
  ['q-aver', 'question', 'A ver.', 'aver'],
  ['q-ahoratedigo', 'question', 'Ahora te digo.', 'digo'],
  ['s-dejamemirar', 'status', 'Déjame mirar.', 'mirar'],
  ['s-ahoratedigo', 'status', 'Ahora te digo.', 'digo'],
  ['s-vamosaver', 'status', 'Vamos a ver.', 'aver'],
  ['o-voy', 'order', 'Voy.', 'voy'],
  ['o-voyaello', 'order', 'Voy a ello.', 'voy'],
  ['o-selodigo', 'order', 'Se lo digo.', 'pasar'],
  ['o-selopaso', 'order', 'Se lo paso.', 'pasar'],
  ['r-aver', 'risky', 'A ver.', 'aver'],
  ['r-dejamever', 'risky', 'Déjame ver.', 'ver'],
  ['h-unmomento', 'hold', 'Un momento.', 'momento'],
  ['h-unsegundo', 'hold', 'Un segundo.', 'segundo'],
];
const EN: [string, ClipCat, string, string][] = [
  ['n-letssee', 'neutral', "Let's see.", 'see'],
  ['n-letmelook', 'neutral', 'Let me look.', 'look'],
  ['q-letmecheck', 'question', 'Let me check.', 'check'],
  ['q-letmesee', 'question', 'Let me see.', 'see'],
  ['q-letmelook', 'question', 'Let me look.', 'look'],
  ['s-letmelook', 'status', 'Let me look.', 'look'],
  ['s-letmecheck', 'status', 'Let me check.', 'check'],
  ['o-onit', 'order', 'On it.', 'onit'],
  ['o-sureonit', 'order', 'Sure, on it.', 'onit'],
  ['o-tellingit', 'order', "I'll tell it.", 'tell'],
  ['r-letssee', 'risky', "Let's see.", 'see'],
  ['r-letmesee', 'risky', 'Let me check.', 'check'],
  ['h-onemoment', 'hold', 'One moment.', 'moment'],
  ['h-onesec', 'hold', 'One sec.', 'second'],
];

export const CLIPS: Clip[] = [
  ...ES.map(([id, cat, text, fam]) => ({ id, cat, lang: 'es' as const, text, fam })),
  ...EN.map(([id, cat, text, fam]) => ({ id, cat, lang: 'en' as const, text, fam })),
];

export const clipKey = (lang: string, id: string) => `${lang}|${id}`;
export const clipById = (lang: string, id: string) =>
  CLIPS.find((c) => c.lang === lang && c.id === id);

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
/** "Mm, déjame mirar." → "mm": the words before the first pause, to spot «A ver. A ver, …». */
export const clipLead = (text: string) =>
  fold(text)
    .replace(/[.!?…]+$/, '')
    .split(/[,;:.]/)[0]
    .trim();
/** A transcript that is just a clip (its echo through the mic). */
export const clipEcho = (transcript: string, clipText: string) =>
  fold(transcript)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() ===
  fold(clipText)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
