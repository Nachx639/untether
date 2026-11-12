/**
 * What the doctor and the security sweep's exposure check see of the project connector
 * (2026-10-31): a channel active and unused for long (a forgotten door), the token store or
 * its folder readable by others (healed: back to 0600/0700), the listener bound beyond
 * loopback, or not listening although a token is active.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ExposureFinding } from '../../../shared/security.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../pty/private-perms.js';
import type { DoctorCheck, DoctorFinding } from '../untether-doctor.js';
import { isLoopback } from './connector-http.js';
import type { ConnectorChannelInfo } from './connector-tokens.js';

/** An active channel nobody used for this long is told about (never revoked on its own). */
export const CONNECTOR_STALE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export interface ConnectorHealthDeps {
  channels: () => ConnectorChannelInfo[];
  /** The connector's folder (tokens.json, messages.json, usage.log). */
  dir: string;
  /** Where it listens now (null: closed). */
  address: () => { host: string; port: number } | null;
  /** Where it is configured to listen (null: turned off). */
  bind: () => { host: string; port: number | null };
  now?: () => number;
}

function lastUse(channel: ConnectorChannelInfo): number {
  return Date.parse(channel.lastUsedAt ?? channel.createdAt);
}

/** Files and the folder others can read, with their modes. */
function laxModes(dir: string): Array<{ file: string; mode: number; want: number }> {
  const out: Array<{ file: string; mode: number; want: number }> = [];
  let entries: string[];
  try {
    const stat = fs.lstatSync(dir);
    if ((stat.mode & 0o077) !== 0)
      out.push({ file: dir, mode: stat.mode & 0o777, want: PRIVATE_DIR_MODE });
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      if ((stat.mode & 0o077) !== 0)
        out.push({ file, mode: stat.mode & 0o777, want: PRIVATE_FILE_MODE });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

export function connectorCheck(deps: ConnectorHealthDeps): DoctorCheck {
  const now = () => deps.now?.() ?? Date.now();
  return {
    id: 'connector',
    run() {
      const findings: DoctorFinding[] = [];
      for (const lax of laxModes(deps.dir)) {
        let healed: string | undefined;
        try {
          fs.chmodSync(lax.file, lax.want);
          healed = `set to ${lax.want.toString(8)}`;
        } catch {
          healed = undefined;
        }
        findings.push({
          key: `connector:mode:${lax.file}`,
          check: 'connector',
          severity: 'critical',
          problem: `${lax.file} was ${lax.mode.toString(8)}: other accounts could read the connector's tokens or messages`,
          ...(healed ? { healed } : {}),
        });
      }
      const channels = deps.channels();
      const active = channels.filter((channel) => channel.active);
      for (const channel of active) {
        const idle = now() - lastUse(channel);
        if (idle < CONNECTOR_STALE_DAYS * DAY) continue;
        findings.push({
          key: `connector:stale:${channel.id}`,
          check: 'connector',
          severity: 'warning',
          problem: `connector channel ${channel.name} (${channel.id}) of ${path.basename(channel.repoPath)} is active but unused for ${Math.floor(idle / DAY)} days: revoke it with \`ut project connector revoke ${channel.id}\` if the app no longer needs it`,
        });
      }
      const bind = deps.bind();
      if (active.length && bind.port !== null) {
        const address = deps.address();
        if (!address) {
          findings.push({
            key: 'connector:not-listening',
            check: 'connector',
            severity: 'warning',
            problem: `${active.length} connector token(s) active but nothing listens on ${bind.host}:${bind.port} (port taken?)`,
          });
        } else if (!isLoopback(address.host)) {
          findings.push({
            key: `connector:bind:${address.host}`,
            check: 'connector',
            severity: 'warning',
            problem: `the connector listens on ${address.host}:${address.port}, beyond loopback (UNTETHER_CONNECTOR_BIND): every host that reaches it can try tokens`,
          });
        }
      }
      return findings;
    },
  };
}

/** The exposure sweep's view of one project's connector: surface lines and findings. */
export function connectorExposure(
  deps: ConnectorHealthDeps,
  repoPath: string
): { surface: string[]; findings: ExposureFinding[] } {
  const now = deps.now?.() ?? Date.now();
  const mine = deps.channels().filter((channel) => channel.repoPath === repoPath && channel.active);
  if (!mine.length) return { surface: [], findings: [] };
  const address = deps.address();
  const where = address ? `${address.host}:${address.port}` : 'not listening';
  const surface = [
    `untether connector: ${mine.length} active channel(s) (${mine.map((channel) => channel.name).join(', ')}) on ${where}; each token sends requests to this project's orchestrator and reads its replies and tasks`,
  ];
  const findings: ExposureFinding[] = [];
  if (address && !isLoopback(address.host)) {
    findings.push({
      key: `untether-connector:bind:${address.host}:${address.port}`,
      source: 'untether-connector',
      severity: 'high',
      title: `Untether's connector listens on ${address.host}:${address.port}, beyond loopback`,
      detail:
        "Anything that reaches that address can present tokens to this project's orchestrator; containers on this Mac reach 127.0.0.1 through host.docker.internal already.",
      fix: 'Unset UNTETHER_CONNECTOR_BIND (back to 127.0.0.1) and restart Untether.',
      fixable: false,
    });
  }
  for (const lax of laxModes(deps.dir)) {
    findings.push({
      key: `untether-connector:mode:${lax.file}`,
      source: 'untether-connector',
      severity: 'high',
      title: `${path.basename(lax.file)} of Untether's connector is readable by others`,
      detail: `Its mode is ${lax.mode.toString(8)}: tokens' hashes and messages could be read by other accounts.`,
      fix: `chmod ${lax.want.toString(8)} ${lax.file} (Untether's doctor does it on its next run)`,
      fixable: false,
    });
  }
  for (const channel of mine) {
    const idle = now - lastUse(channel);
    if (idle < CONNECTOR_STALE_DAYS * DAY) continue;
    findings.push({
      key: `untether-connector:stale:${channel.id}`,
      source: 'untether-connector',
      severity: 'low',
      title: `Connector channel ${channel.name} unused for ${Math.floor(idle / DAY)} days`,
      detail: 'An active token nobody uses is a way in nobody watches.',
      fix: `ut project connector revoke ${channel.id}`,
      fixable: false,
    });
  }
  return { surface, findings };
}
