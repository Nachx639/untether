/**
 * Safety gate, enforced in code (the prompt asks for the same, but the prompt is not trusted).
 *
 * Three tiers for what Claude asks permission for:
 *  - safe: reads, searches, edits inside the session's folder, tests/lint/build, git status/diff/log.
 *    A bare "sí" answers it.
 *  - sensitive/risky: deletes, pushes (force above all), resets, deploys, publishing, sudo, killing
 *    processes, global installs, curl|sh, permission bypasses, and writes outside the project or to
 *    keys/shell/system config. Needs "confirmo".
 *  - any other command: "sí" is fine; the spoken line says in plain words what it does.
 *
 * Authorization comes only from a hold slot: the copilot restated one exact action (and menu key),
 * and the user's next utterance is a bare confirmation (no question, no other clause), within 60 s.
 * One "confirmo" runs one held action.
 */
import os from 'node:os';
import path from 'node:path';

export const RISKY_COMMAND =
  /\brm\b|\brmdir\b|\bdelete\b|\bunlink\b|\bdrop\b|\btruncate\b|git\s+push|--force\b|\bpush\b.*\s-f\b|reset\s+--hard|clean\s+-f|\bdeploy|\bpublish|npm\s+publish|npm\s+run\s+release|\bsudo\b|\bchmod\b|\bchown\b|curl\s[^|]*\|\s*(ba|z)?sh|\bkill(all)?\b|\bpkill\b|launchctl|brew\s+(un)?install|--dangerously|bypass|rmtree|git\s+checkout\s+--\s|git\s+restore\b|branch\s+-D\b|stash\s+(drop|clear)|commit\s+--amend|gh\s+pr\s+merge|npm\s+(i|install|add)\s+(-g|--global)\b|pip3?\s+install|docker\b.*\bprune|migrate\s+reset|db[:\s](reset|drop)|\bdropdb\b|\brimraf\b|\bdel-cli\b|\btrash\b|\bshred\b|\bfind\b.*-delete|git\s+reset\b|git\s+clean\b|--prod\b|\b(to|deploy\w*|push\w*|release)\s+(prod|production)\b|crontab\s+-r|\bdd\s+if=|\bmkfs|\bdropping\b|git\s+branch\s+(-d|--delete)\b|git\s+push\s+\S+\s+--delete|git\s+revert\b|git\s+checkout\s+(\.|--\s*\.|-f\b)|git\s+switch\s+(-f|--force|--discard-changes)\b|stash\s+(-u|--include-untracked|--all)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(release|publish|deploy|ship)\b|gh\s+release\b|terraform\s+(apply|destroy)\b|kubectl\s+(apply|delete)\b|make\s+(deploy|release)\b|\bscp\b|\brsync\b[^|;&]*\S:|\bnc\b\s|\bsecurity\s+find-/i;

/** 2026-10-12 (judge round 3): `curl -d @.env` sent the secrets file out on a bare «sí». */
export const SENDS_DATA_OUT =
  /\b(curl|wget|http|httpie)\b[^|;&]*(\s-d\b|--data|\s-F\b|--form|\s-T\b|--upload-file|\s@\S|--post-file)|\bscp\b|\brsync\b[^|;&]*\S:|\bnc\b\s/i;
export const NAMES_SECRET =
  /(^|[\s/'"@=])\.env(\.[\w-]+)?\b|id_rsa|id_ed25519|\.ssh\/|security\s+find-|\.aws\/credentials|\.npmrc|\.netrc/i;

/**
 * A package manager adding a named package (`npm i -D foo`, `pnpm add foo`, `yarn add foo`),
 * as opposed to installing what the lockfile already lists (`pnpm install`, `npm ci`).
 * 2026-10-20: `(npm|pnpm|yarn|bun) install` was on the safe list whatever followed, so a bare
 * «sí» let a session pull any package (and run its install scripts). Adding one needs «confirmo».
 */
export const ADDS_PACKAGE =
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b(\s+--?[\w-]+(=\S+)?)*\s+[^\s\-|;&<>]/i;

/** Shell writes (redirects, tee, sed -i, mv, cp) whose target is sensitive or outside the project. */
export function shellWriteRisk(cmd: string, cwd?: string): 'sensitive' | 'outside' | null {
  const targets: string[] = [];
  for (const m of cmd.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";|&]+)\1/g))
    targets.push(m[2]);
  for (const m of cmd.matchAll(/\bsed\s+-i\S*\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;|&]+)/g))
    targets.push(m[1]);
  for (const m of cmd.matchAll(/\b(?:mv|cp|ln)\s+(?:-\w+\s+)*\S+\s+([^\s;|&]+)/g))
    targets.push(m[1]);
  let out: 'sensitive' | 'outside' | null = null;
  for (const t of targets) {
    if (/^\/dev\/(null|stderr|stdout)$|^&\d$/.test(t)) continue;
    const home = os.homedir();
    const expanded = t.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home);
    const abs = expanded.startsWith('/')
      ? path.normalize(expanded)
      : cwd
        ? path.resolve(cwd, expanded)
        : expanded;
    if (SENSITIVE_PATH.test(abs) || SENSITIVE_PATH.test(t)) return 'sensitive';
    const outside = cwd
      ? !abs.startsWith(`${cwd.replace(/\/$/, '')}/`)
      : /^(~|\/|\.\.\/|\$HOME)/.test(t);
    if (outside) out = 'outside';
  }
  return out;
}

/**
 * Commands a bare «sí» may approve (2026-10-12, judge round 3: unlisted commands were approved on
 * «sí»). Everything else is default-confirm.
 */
export const SAFE_COMMAND =
  /^\s*(cd\s+\S+\s*&&\s*)?(ls|cat|head|tail|wc|tree|pwd|echo|grep|rg|find(?![^|;&]*-(delete|exec))|which|file|stat|du|df|date|node\s+--version|python3?\s+--version|git\s+(status|diff|log|show|branch(\s+-[av]+)?|add|commit(?![^|;&]*--amend)|fetch|remote\s+-v|stash(\s+list)?$)|(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|typecheck|check|format|dev|start|ci|install|i|outdated|ls)\b|npx\s+(tsc|eslint|prettier|vitest|jest|biome|playwright\s+test)\b|tsc\b|vitest\b|jest\b|eslint\b|prettier\b|biome\b|pytest\b|python3?\s+-m\s+(pytest|unittest)\b|go\s+(test|build|vet)\b|cargo\s+(test|build|check|clippy)\b|ruff\b|mypy\b|make\s+(test|build|lint|check)?\s*$|(npm|pnpm|yarn)\s+run\s+(migrate|db:migrate|test:\S+|lint:\S+|build:\S+)\b|npx\s+prisma\s+(generate|migrate\s+(dev|status))\b)/i;

/** 2026-10-12 (judge round 2): "Clean build artifacts" hid a rimraf. Claude's own description is read too. */
export const DESTRUCTIVE_DESCRIPTION =
  /\b(remov|delet|drop|wip|reset|destroy|purg|eras|overwrit|clean|borr|elimin|vac[ií]a|descart|discard|revert|restor|undo|force|release|publish|deploy|upload|share|send|leak)\w*/i;

/** Spanish/English orders that ask for something risky. */
export const RISKY_ORDER =
  /\b(borr|elimin|suprim|quit[ae] (el|la|los|las) (fichero|archivo|carpeta)|destru|machac|sub(e|es|en|ir|ir[lo]+|a|as|an|elo|ela|elos|amos|ido)\b|súbel|push|despleg|desplieg|deploy|public|publish|mat[ae]r?\b|kill|forz|force|reset(ea)?\b.*hard|resete|sudo|rm\b|drop\b|delete|remove|wipe|merge(a|ar)? (a|en) main|fusiona|bypass|sin pedir permiso|no (te |le )?pregunte|mand\w* a (producci|prod)|(sub|pas|llev|pon)\w* (\w+ )?(a|en) producci|c[aá]rga(te|r|rse)(l[aoe]s?)?\b|se (l[aoe]s? )?cargu?e|cargarse|como estaba|dej\w* .*limpi|deshaz|deshac|revierte|revertir|revert|descart|tira\w* (los )?cambios|vuelve atr[aá]s|volver atr[aá]s|de cero|pasa\w* a main|mergea)/i;

/** "no lo subas", "sin borrar nada": a negated risky verb is not a risky order. */
const NEGATED_RISK =
  /\b(no|nunca|sin|ni)\s+(lo |la |los |las |le |se |me |nada |todav[ií]a |a[uú]n )*(sub|borr|elimin|despleg|desplieg|public|push|forz|mand|cargu|toque|mates?)\w*/gi;

/** Whether the user's own words ask for something risky (negations removed first). */
export function riskyWords(text: string) {
  return RISKY_ORDER.test(text.replace(NEGATED_RISK, ' '));
}

/** Write/edit targets that are never a "normal" permission. */
export const SENSITIVE_PATH =
  /(^|\/)\.ssh(\/|$)|\/\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile|gitconfig|npmrc|netrc)$|\/\.config\/|(^|\/)\.env(\.[\w-]+)?$|LaunchAgents|LaunchDaemons|^\/etc\/|^\/usr\/|^\/Library\/|^\/System\/|\/\.aws\/|\/\.gnupg\//;

export const DONT_ASK_AGAIN =
  /don.?t ask again|no volver a preguntar|always|siempre|for this session|durante esta sesi/i;

export const CONFIRM_WORD = /\b(confirm[oó]|confirmado|confirm|confirmed)\b/i;

/**
 * The whole utterance is a confirmation and nothing else ("confirmo", "sí, confirmo", "confirm.").
 * 2026-10-13 (live smoke test): whisper wrote a spoken «Confirmo.» as «confirmó.»; same word.
 */
export const BARE_CONFIRM =
  /^\s*((s[ií]|vale|venga|ok|yes)[,.\s]+)?(lo\s+|i\s+)?(confirm[oó]|confirmado|confirm(ed)?)[.!\s]*$/i;

/** "confirmo, y luego …": a confirmation followed by a separate clause. */
export const LEAD_CONFIRM =
  /^\s*((s[ií]|vale|ok|yes)[,.\s]+)?(confirm[oó]|confirmado|confirm(ed)?)\s*[,.;:]\s*(?:(?:y|and)\s+)?(?:(?:luego|despu[eé]s|tambi[eé]n|then|also)\s+)?(.+)$/i;

/**
 * The clause after «confirmo, …» takes it back («confirmo, pero no», «… no, espera, no lo hagas»,
 * «… aunque mejor no lo subas»). 2026-10-13 (review): those ran the held action.
 */
export const RETRACT =
  /\b(no|espera\w*|aguanta|cancel\w*|olvid\w*|mejor\s+no|wait|stop|don.?t|not|never\s*mind|hold\s+on)\b/i;
/** A clause that hedges («confirmo, pero…», «…, aunque…»): ask again for a bare «confirmo». */
export const HEDGE = /\b(pero|aunque|sino|but|though|although|unless)\b/i;

/** Utterance is (only) a confirmation: never a question, never "no". */
export function isConfirmation(utterance: string) {
  return BARE_CONFIRM.test(utterance) && !/\?|\bno\b/i.test(utterance);
}

export interface PendingConfirmation {
  /** The action line, normalized (e.g. "@answer s2 1"). */
  action: string;
  sid: string;
  /** Menu key it applies to (answers only). */
  key?: string;
  /** Verb phrase spoken to the user ("forzar la subida a main"): repeated verbatim on expiry. */
  restatement: string;
  at: number;
  /** Times the copilot has asked for «confirmo» for this same slot. */
  asked: number;
  /**
   * When this exact slot (action + menu) was first armed. A confirmation whose utterance began
   * before it was meant for something else (2026-10-13, user report via review: a «confirmo» for
   * a held push approved the `rm -rf` menu that replaced it while whisper was transcribing).
   */
  armedAt: number;
}

export const CONFIRM_TTL_MS = 60_000;

export class SafetyGate {
  pending: PendingConfirmation | null = null;

  /** Whether `utterance` authorizes `action` (fresh slot, same action, same menu, bare confirmation). */
  confirms(
    utterance: string,
    action: string,
    key?: string,
    now = Date.now(),
    utteranceAt?: number
  ): boolean {
    const p = this.pending;
    if (!p || !isConfirmation(utterance)) return false;
    if (now - p.at > CONFIRM_TTL_MS) return false;
    if (utteranceAt !== undefined && this.predates(utteranceAt)) return false;
    if (normalize(p.action) !== normalize(action)) return false;
    if (p.key && key && p.key !== key) return false;
    return true;
  }

  /** Arm (or re-arm) the slot. Returns how many times this same slot was already asked about. */
  hold(p: Omit<PendingConfirmation, 'at' | 'asked' | 'armedAt'>, now = Date.now()): number {
    const prev = this.pending;
    const same =
      prev &&
      normalize(prev.action) === normalize(p.action) &&
      (prev.key ?? '') === (p.key ?? '') &&
      now - prev.at <= CONFIRM_TTL_MS;
    const asked = same ? prev.asked + 1 : 1;
    this.pending = { ...p, at: now, asked, armedAt: same ? prev.armedAt : now };
    return asked - 1;
  }

  /** The utterance began before the held slot was armed: it cannot be about it. */
  predates(utteranceAt: number) {
    return Boolean(this.pending && utteranceAt < this.pending.armedAt);
  }

  clear() {
    this.pending = null;
  }

  fresh(now = Date.now()) {
    return this.pending && now - this.pending.at <= CONFIRM_TTL_MS ? this.pending : null;
  }

  expired(now = Date.now()) {
    return Boolean(this.pending && now - this.pending.at > CONFIRM_TTL_MS);
  }
}

export function normalize(action: string) {
  return action.trim().replace(/\s+/g, ' ').toLowerCase();
}

const MAIN = /\b(main|master)\b/i;

/** Verb phrase for a risky command or order, in plain words ("forzar la subida a main"). */
export function riskVerb(text: string, lang = 'es'): string {
  const en = lang === 'en';
  const toMain = MAIN.test(text) || /git\s+push|\bpush\b|github|\bsub/i.test(text);
  if (SENDS_DATA_OUT.test(text) && NAMES_SECRET.test(text))
    return en ? 'send your secrets file to the internet' : 'mandar tus claves a internet';
  if (SENDS_DATA_OUT.test(text))
    return en ? 'send project data to the internet' : 'mandar datos del proyecto a internet';
  if (
    /git\s+checkout\s+(\.|--\s*\.|-f\b)|git\s+switch\s+(-f|--force|--discard-changes)|stash\s+(-u|--include-untracked|--all)/i.test(
      text
    )
  )
    return en ? 'throw away the unsaved changes' : 'descartar los cambios sin guardar';
  if (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(release|publish|ship)\b|gh\s+release|make\s+release/i.test(
      text
    )
  )
    return en ? 'publish a new version' : 'publicar una versión nueva';
  if (/terraform\s+(apply|destroy)|kubectl\s+(apply|delete)/i.test(text))
    return en ? 'change live servers' : 'tocar servidores reales';
  // Force first: it rewrites remote history, never say it as a plain push.
  if (
    /push\b[^|;&]*(--force|--force-with-lease|\s-f\b)|(--force|\s-f\b)[^|;&]*\bpush\b|\bforz|force.?push/i.test(
      text
    )
  )
    return en
      ? `force-push${toMain ? ' to GitHub' : ''}, which can erase history`
      : `forzar la subida${toMain ? ' a GitHub' : ''}, que puede borrar el historial`;
  if (
    /migrate\s+reset|db[:\s](reset|drop)|dropdb|\bdrop\b|dropping|\btruncate\b|borr\w* (todas )?las tablas|tablas/i.test(
      text
    ) &&
    /reset|drop|truncate|borr|tabla|base de datos|database/i.test(text)
  )
    return en ? 'wipe the database' : 'borrar la base de datos';
  if (
    /reset\s+--hard|git\s+reset\b|resete|git\s+checkout\s+--\s|git\s+restore\b|git\s+clean\b|clean\s+-f|descart|discard|como estaba|deshaz|deshac|revierte|revert|tira\w* (los )?cambios|vuelve atr[aá]s|volver atr[aá]s|dej\w* .*limpi/i.test(
      text
    )
  )
    return en ? 'throw away changes' : 'descartar cambios';
  if (/stash\s+(drop|clear)/i.test(text))
    return en ? 'throw away saved changes' : 'tirar cambios guardados';
  if (
    /branch\s+(-D|-d|--delete)|push\s+\S+\s+--delete|\brama\b|\bbranch\b/i.test(text) &&
    /borr|elimin|delete|-D\b|-d\b|cargu|carga|quit/i.test(text)
  )
    return en ? 'delete a branch' : 'borrar una rama';
  if (/deploy|despleg|desplieg|producci[oó]n|--prod\b|\bprod\b/i.test(text))
    return en ? 'deploy to production' : 'desplegar a producción';
  if (/commit\s+--amend/i.test(text))
    return en ? 'rewrite the last commit' : 'reescribir el último commit';
  if (/gh\s+pr\s+merge|merge(a|ar)? (a|en) main|fusiona/i.test(text))
    return en ? 'merge the change' : 'fusionar el cambio';
  if (
    /git\s+push|\bpush\b|\bsub(e|es|en|ir|irlo|irla|a|as|an|elo|ela|elos|amos|ido)\b|súbel/i.test(
      text
    )
  )
    return en ? 'push to GitHub' : 'subirlo a GitHub';
  if (/npm\s+publish|npm\s+run\s+release|publish|public/i.test(text))
    return en ? 'publish the package' : 'publicar el paquete';
  if (/\brm\b[^|;&]*\b(dist|build|out|\.next)\b/i.test(text))
    return en ? 'delete the build folder' : 'borrar la carpeta de compilación';
  if (/\brimraf\b|\bdel-cli\b/i.test(text) && /node_modules|src\b/i.test(text))
    return en ? 'delete folders, including generated code' : 'borrar carpetas del proyecto';
  if (/\b(dist|build)\b/i.test(text) && /borr|elimin|delete|remove|rimraf|clean/i.test(text))
    return en ? 'delete the build folder' : 'borrar la carpeta de compilación';
  if (
    /\brm\b|rmdir|rmtree|rimraf|del-cli|trash|shred|-delete|delete|unlink|borr|elimin|remove|wipe|suprim|c[aá]rga|cargu|vac[ií]a/i.test(
      text
    )
  )
    return en ? 'delete files' : 'borrar archivos';
  if (/npm\s+(i|install|add)\s+(-g|--global)|pip3?\s+install|brew\s+(un)?install/i.test(text))
    return en ? 'install programs on your Mac' : 'instalar programas en tu Mac';
  if (/curl\s[^|]*\|\s*(ba|z)?sh/i.test(text))
    return en ? 'run a script from the internet' : 'ejecutar un script de internet';
  if (/sudo|chmod|chown/i.test(text))
    return en ? 'change system permissions' : 'tocar permisos del sistema';
  if (/launchctl/i.test(text)) return en ? 'change system services' : 'tocar servicios del sistema';
  if (/crontab\s+-r/i.test(text))
    return en ? 'delete your scheduled tasks' : 'borrar tus tareas programadas';
  if (/\bdd\s+if=|\bmkfs/i.test(text)) return en ? 'overwrite a disk' : 'sobrescribir un disco';
  if (/kill|mat[ae]r/i.test(text)) return en ? 'kill processes' : 'parar procesos';
  if (/docker\b.*\bprune/i.test(text))
    return en ? 'clean up Docker data' : 'borrar datos de Docker';
  if (
    /don.?t ask again|always|siempre|bypass|dangerously|sin pedir permiso|no (te |le )?pregunte/i.test(
      text
    )
  )
    return en ? 'stop asking for permission' : 'quitarle las preguntas de permiso';
  return en ? 'do something delicate' : 'hacer algo delicado';
}

/** What to say once a confirmed risky action is running ("Subiendo."). */
export function riskGerund(verb: string, lang = 'es'): string {
  const en = lang === 'en';
  const v = verb.toLowerCase();
  const table: [RegExp, string, string][] = [
    [/^forzar|^force/, 'Forzando la subida.', 'Force-pushing.'],
    [/^subir|^push/, 'Subiendo.', 'Pushing.'],
    [/^mandar|^send/, 'Mandando.', 'Sending.'],
    [/^publicar una|^publish a/, 'Publicando la versión.', 'Publishing.'],
    [/^publicar|^publish/, 'Publicando.', 'Publishing.'],
    [/^desplegar|^deploy/, 'Desplegando.', 'Deploying.'],
    [/^borrar la base|^wipe/, 'Borrando la base de datos.', 'Wiping it.'],
    [/^borrar|^delete|^tirar/, 'Borrando.', 'Deleting.'],
    [/^descartar|^throw/, 'Descartando los cambios.', 'Throwing them away.'],
    [/^fusionar|^merge/, 'Fusionando.', 'Merging.'],
    [/^instalar|^install/, 'Instalando.', 'Installing.'],
    [/^parar|^kill/, 'Parando procesos.', 'Killing them.'],
    [/^reescribir|^rewrite/, 'Reescribiendo.', 'Rewriting.'],
  ];
  for (const [re, es, enText] of table) if (re.test(v)) return en ? enText : es;
  return en ? 'Done.' : 'Hecho.';
}

export interface MenuRisk {
  risky: boolean;
  /** Risky only because the command is not one we know (no destructive sign seen). */
  unknown?: boolean;
  /** Plain verb phrase of what Claude wants ("pasar los tests", "tocar tus claves SSH"). */
  verb?: string;
}

/**
 * Classify a permission menu. `detail` is Untether's parsed detail: [header, command|path, description].
 * `cwd` is the session's working directory (writes outside it are sensitive).
 */
export function menuRisk(
  question: string,
  detail: string[] = [],
  cwd?: string,
  lang = 'es',
  options: string[] = []
): MenuRisk {
  const en = lang === 'en';
  // The options can name what it is about («Yes, and don't ask again for rm commands»).
  const optionText = options.filter((o) => !/^\s*no\b/i.test(o)).join(' ');
  const head = detail[0] ?? '';
  const target = detail[1] ?? '';
  const description = detail[2] ?? '';
  const about = `${question} ${detail.join(' ')}`;
  if (/^(Create|Write|Edit|Update|MultiEdit|NotebookEdit)\b/i.test(head) && target) {
    // 2026-10-12: "../facturacion/config/produccion.json" counted as inside the project. Resolve first.
    const home = os.homedir();
    const expanded = target.startsWith('~') ? home + target.slice(1) : target;
    const abs = expanded.startsWith('/')
      ? path.normalize(expanded)
      : cwd
        ? path.resolve(cwd, expanded)
        : '';
    const outside =
      abs && cwd
        ? !abs.startsWith(`${cwd.replace(/\/$/, '')}/`)
        : /(^|\/)\.\.(\/|$)/.test(target) || (expanded.startsWith('/') && !cwd);
    const p = abs || target;
    if (/(^|\/)\.ssh(\/|$)/.test(p))
      return { risky: true, verb: en ? 'change your SSH keys' : 'tocar tus claves SSH' };
    if (/\/\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile)$/.test(p))
      return {
        risky: true,
        verb: en ? 'change your terminal settings' : 'cambiar la configuración de tu terminal',
      };
    if (/LaunchAgents|LaunchDaemons/.test(p))
      return {
        risky: true,
        verb: en
          ? 'install a service that starts on its own'
          : 'instalar un servicio que arranca solo',
      };
    if (/(^|\/)\.env(\.[\w-]+)?$/.test(p))
      return {
        risky: true,
        verb: en ? 'change the project secrets file' : 'tocar el fichero de claves del proyecto',
      };
    if (SENSITIVE_PATH.test(p))
      return {
        risky: true,
        verb: en ? 'change system settings' : 'tocar la configuración del sistema',
      };
    if (outside)
      return {
        risky: true,
        verb: en ? 'write outside the project' : 'escribir fuera del proyecto',
      };
    return { risky: false };
  }
  const bash = /^Bash/i.test(head);
  if (bash && target) {
    if (SENDS_DATA_OUT.test(target)) return { risky: true, verb: riskVerb(target, lang) };
    if (ADDS_PACKAGE.test(target))
      return {
        risky: true,
        verb: en ? 'add packages to the project' : 'añadir paquetes al proyecto',
      };
    const w = shellWriteRisk(target, cwd);
    if (w === 'sensitive') {
      if (/\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile)\b/.test(target))
        return {
          risky: true,
          verb: en ? 'change your terminal settings' : 'cambiar la configuración de tu terminal',
        };
      if (/\.env\b/.test(target))
        return {
          risky: true,
          verb: en ? 'change the project secrets file' : 'tocar el fichero de claves del proyecto',
        };
      return {
        risky: true,
        verb: en ? 'change system settings' : 'tocar la configuración del sistema',
      };
    }
    if (w === 'outside')
      return {
        risky: true,
        verb: en ? 'write outside the project' : 'escribir fuera del proyecto',
      };
  }
  if (RISKY_COMMAND.test(about)) return { risky: true, verb: riskVerb(about, lang) };
  if (optionText && RISKY_COMMAND.test(optionText))
    return { risky: true, verb: riskVerb(optionText, lang) };
  // 2026-10-13 (review): a permission dialog taller than the screen, or a Codex menu, comes with
  // no detail: the command is unseen, so a bare «sí» must not approve it (default-confirm).
  if (!target && permissionPrompt(question, options)) {
    const edit = /\b(edit|create|write|make this edit|overwrite)\b|edita|crea|escrib/i.test(
      `${question} ${head}`
    );
    return {
      risky: true,
      unknown: true,
      verb: edit
        ? en
          ? "change a file I can't see"
          : 'cambiar un archivo que no veo'
        : en
          ? "run a command I can't see"
          : 'ejecutar un comando que no veo',
    };
  }
  // Claude's description of an unknown or innocent-looking command can give the delete away.
  if (
    !(bash && target && allSafe(target)) &&
    (DESTRUCTIVE_DESCRIPTION.test(description) || (bash && DESTRUCTIVE_DESCRIPTION.test(target)))
  ) {
    const v = riskVerb(about, lang);
    return {
      risky: true,
      verb: /delicado|delicate/.test(v)
        ? en
          ? 'delete or reset something'
          : 'borrar o reiniciar algo'
        : v,
    };
  }
  // Only the command itself names what it does (never the description: "Clean build artifacts").
  // Unknown shell commands are default-confirm: a bare «sí» only passes what we can name.
  if (bash && target && !allSafe(target))
    return {
      risky: true,
      verb: en ? "run a command I don't know" : 'ejecutar un comando que no conozco',
      unknown: true,
    };
  return { risky: false, verb: plainCommandVerb(target, lang) };
}

/** A tool-permission dialog (not a plan approval or a plain question Claude asks). */
function permissionPrompt(question: string, options: string[]) {
  const opts = options.join(' ');
  if (/auto-accept|keep planning|manually approve|seguir planificando/i.test(opts)) return false;
  return (
    /\b(proceed|allow|permit|run|execute|approve|make this edit|do you want to (create|edit|write|make|fetch|use))\b|ejecut|permit|continuar\?/i.test(
      question
    ) || options.some((o) => DONT_ASK_AGAIN.test(o))
  );
}

/** Destructive verbs in a menu option's own words (parentheticals removed: "(already deployed)"). */
const OPTION_RISK =
  /\b(borr|elimin|suprim|delet|remov|drop\b|wipe|reset|destroy|destru|purg|eras|truncat|descart|discard|revert|deshac|forz|force|push|sub(ir|e|elo|irlo)\b|despleg|desplieg|deploy\b|publica|publish|empezar de cero|de cero|from scratch|sobrescrib|overwrit)/i;

/** Whether a menu option's own text is destructive ("Borrar todas las tablas y empezar de cero"). */
export function optionRisk(label: string, lang = 'es'): MenuRisk {
  const t = label.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
  if (/^no\b/i.test(t)) return { risky: false };
  if (
    (RISKY_COMMAND.test(t) &&
      /\b(rm|git|sudo|kill|drop|delete|reset|push|deploy|publish|rimraf)\b/i.test(t)) ||
    OPTION_RISK.test(t)
  ) {
    const v = riskVerb(t, lang);
    return {
      risky: true,
      verb: /delicado|delicate/.test(v)
        ? lang === 'en'
          ? 'do something destructive'
          : 'borrar algo'
        : v,
    };
  }
  return { risky: false };
}

/** Plain words for common safe commands; undefined when unknown. */
export function plainCommandVerb(text: string, lang = 'es'): string | undefined {
  const en = lang === 'en';
  if (/integration|integraci/i.test(text) && /test/i.test(text))
    return en ? 'run the integration tests' : 'pasar los tests de integración';
  if (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo test\b|cargo test|run (the )?tests?|\btest:/i.test(
      text
    )
  )
    return en ? 'run the tests' : 'pasar los tests';
  if (/\b(lint|eslint|biome|prettier|ruff)\b/i.test(text))
    return en ? 'check the code style' : 'revisar el estilo';
  if (/\b(typecheck|tsc)\b/i.test(text)) return en ? 'check the types' : 'revisar los tipos';
  if (/\bbuild\b|compil/i.test(text)) return en ? 'build the project' : 'compilar';
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|install dependencies/i.test(text))
    return en ? 'install dependencies' : 'instalar dependencias';
  if (/\bgit\s+(status|diff|log|show)\b/i.test(text))
    return en ? 'look at the changes' : 'mirar los cambios';
  if (/\bgit\s+(add|commit)\b/i.test(text))
    return en ? 'save the changes in git' : 'guardar los cambios en git';
  if (/\bmigrat/i.test(text)) return en ? 'migrate the database' : 'migrar la base de datos';
  if (/^\s*(ls|cat|head|tail|find|grep|rg|wc|tree)\b/i.test(text))
    return en ? 'look at some files' : 'mirar unos archivos';
  if (/\b(npm|pnpm|yarn)\s+run\s+dev\b|start (the )?(dev )?server/i.test(text))
    return en ? 'start the dev server' : 'arrancar el servidor de pruebas';
  return undefined;
}

/**
 * Options that make a "safe" command run or write something: git's --output/--upload-pack/
 * --exec/-c/--config, ripgrep's --pre, find's -exec/-ok/-fprint, tree -o.
 */
const UNSAFE_OPTION =
  /^\s*git\b.*(\s--(output|upload-pack|receive-pack|exec|config|ext-diff|textconv|git-dir|work-tree)\b|\s-c\b|\s-C\b)|^\s*git\s+-|^\s*rg\b.*\s--pre\b|^\s*find\b.*\s-(exec|execdir|ok|okdir|fprint|fprintf|fls|delete)\b|^\s*tree\b.*\s-o\b/;

/**
 * Every part of a chained command (`a && b | c`) is a known safe command.
 * 2026-10-20 (security audit): SAFE_COMMAND only looks at how a part starts, so these passed
 * on a bare «sí»: `env node -e …`, "echo `node -e …`", `git fetch --upload-pack='cmd'`,
 * `git diff --output=~/.zshrc`, and `cat x` + newline + `node evil.js`. Command
 * substitution, newlines and file redirects are never "safe"; env/printenv left the list.
 */
export function allSafe(cmd: string) {
  if (/[`\n\r]|\$\(|\$\{|[<>]\(/.test(cmd)) return false;
  // Output thrown away or merged (2>/dev/null, 2>&1) is fine; any other > or >> writes a file.
  const withoutHarmless = cmd.replace(/\d*>>?\s*\/dev\/null\b|\d*>&\d\b/g, ' ');
  if (/>/.test(withoutHarmless)) return false;
  const parts = withoutHarmless.split(/\s*(?:&&|\|\||[;|&])\s*/).filter((p) => p.trim());
  return (
    parts.length > 0 &&
    parts.every((p) => SAFE_COMMAND.test(p) && !UNSAFE_OPTION.test(p) && !ADDS_PACKAGE.test(p))
  );
}
