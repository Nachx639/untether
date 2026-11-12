// Command-line configuration of the server: parsing, help, validation and the no-auth guards.
import * as fs from 'fs';
import * as os from 'os';
import { MAC_SESSIONS_CLI_FLAG } from './services/mac-sessions/settings.js';
import { MAC_SHARE_CLI_FLAG } from './services/mac-sessions/share-settings.js';
import {
  refusesRealTailscaleReset,
  serveRoutesForPort,
} from './services/tailscale-serve-service.js';
import { colors } from './utils/colors.js';
import { takeLocalAuthToken } from './utils/local-auth-token.js';
import { createLogger } from './utils/logger.js';
import { every } from './utils/periodic-loop.js';

const logger = createLogger('server');

export interface Config {
  port: number | null;
  bind: string | null;
  /** Dev-server preview listener port ("off" disables); main port + 1 when unset. */
  previewPort: string | null;
  enableSSHKeys: boolean;
  disallowUserPassword: boolean;
  noAuth: boolean;
  /** --unsafe-no-auth-on-network: allow --no-auth on a non-loopback bind or a tunnel. */
  unsafeNoAuthOnNetwork: boolean;
  isHQMode: boolean;
  hqUrl: string | null;
  hqUsername: string | null;
  hqPassword: string | null;
  remoteName: string | null;
  remoteUrl: string | null;
  allowInsecureHQ: boolean;
  showHelp: boolean;
  showVersion: boolean;
  debug: boolean;
  // Push notification configuration
  pushEnabled: boolean;
  vapidEmail: string | null;
  // Local bypass configuration
  allowLocalBypass: boolean;
  localAuthToken: string | null;
  // Tailscale Serve integration (manages auth and proxy)
  enableTailscaleServe: boolean;
  // Tailscale Funnel integration (public internet access)
  enableTailscaleFunnel: boolean;
  // HQ auth bypass for testing
  noHqAuth: boolean;
  // mDNS advertisement
  enableMDNS: boolean;
  // Ngrok tunnel configuration
  enableNgrok: boolean;
  ngrokAuthToken: string | null;
  ngrokDomain: string | null;
  ngrokRegion: string | null;
  // Cloudflare tunnel configuration
  enableCloudflare: boolean;
  /** --no-mac-sessions: "On this Mac" is off whatever Settings says. */
  noMacSessions: boolean;
  /** --no-mac-share: "Share with phone" is off whatever Settings says. */
  noMacShare: boolean;
}

/**
 * Resolve the URL the HQ will use to connect back to a remote server.
 *
 * Precedence:
 *  1. An explicit `--remote-url` (`remoteUrl`) is normalized to an origin.
 *  2. Otherwise the URL is derived from the bind address.
 *  3. When bound to all interfaces (`0.0.0.0` or `::`), the machine's hostname is used.
 *
 * The hostname fallback (3) can be unreachable from the HQ — e.g. a mixed-case
 * or non-DNS local hostname like `My-Laptop.local` that the HQ can't resolve.
 * That is exactly what `--remote-url` is for: pass a tailnet IP or a resolvable
 * name so the HQ's back-connection (session reads, input) actually works.
 *
 * @param remoteUrl  Explicit override (`--remote-url`), or null/undefined.
 * @param bindAddress The address the server bound to (`--bind`, default 0.0.0.0).
 * @param port        The actual listening port.
 * @param hostname    Injectable for testing; defaults to os.hostname().
 */
export function resolveRemoteUrl(
  remoteUrl: string | null | undefined,
  bindAddress: string,
  port: number,
  hostname: () => string = os.hostname
): string {
  if (remoteUrl !== null && remoteUrl !== undefined) {
    return normalizeRemoteUrl(remoteUrl);
  }
  const remoteHost = bindAddress === '0.0.0.0' || bindAddress === '::' ? hostname() : bindAddress;
  const formattedHost =
    remoteHost.includes(':') && !remoteHost.startsWith('[') ? `[${remoteHost}]` : remoteHost;
  return `http://${formattedHost}:${port}`;
}

export function normalizeRemoteUrl(remoteUrl: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(remoteUrl);
  } catch {
    throw new Error('--remote-url must be a valid HTTP or HTTPS URL');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('--remote-url must use HTTP or HTTPS');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('--remote-url must not include credentials');
  }
  if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
    throw new Error('--remote-url must not include a path, query, or fragment');
  }

  return parsedUrl.origin;
}

/** The --help text. `server-config-help.test.ts` holds every option in it against parseArgs. */
export function helpText(): string {
  return `
Untether Server - Terminal Multiplexer

Usage: untether [options]

Options:
  --help                Show this help message
  --version             Show version information
  --port <number>       Server port (default: 4020 or PORT env var)
  --bind <address>      Bind address (default: 0.0.0.0, all interfaces)
  --preview-port <port> Dev-server preview listener, a separate origin (default: port + 1,
                        "off" disables; env UNTETHER_PREVIEW_PORT)
  --enable-ssh-keys     Enable SSH key authentication UI and functionality
  --disallow-user-password  Disable password auth, SSH keys only (auto-enables --enable-ssh-keys)
  --no-auth             Disable authentication (auto-login as current user). Binds
                        127.0.0.1 unless --bind is given; refused on any other address
                        or with a tunnel unless --unsafe-no-auth-on-network
  --unsafe-no-auth-on-network  Allow --no-auth on a network address or tunnel: anyone
                        who reaches the port gets a shell on this computer
  --allow-local-bypass  Allow localhost connections that carry the local auth token
                        (env UNTETHER_LOCAL_AUTH_TOKEN) to bypass authentication;
                        without a token no connection bypasses it
  --enable-tailscale-serve  Enable Tailscale Serve integration (auto-manages proxy and auth;
                        the server then listens on 127.0.0.1 only, whatever --bind says)
  --enable-tailscale-funnel Enable Tailscale Funnel for public internet access (requires --enable-tailscale-serve)
  --no-mac-sessions     Don't list this computer's tmux sessions and the agents running
                        outside Untether ("On this Mac"), whatever Settings says
  --no-mac-share        Don't offer "Share with phone" for agents in Terminal or iTerm2
                        tabs, whatever Settings says
  --debug               Enable debug logging

Push Notification Options:
  --push-enabled        Enable push notifications (default: enabled)
  --push-disabled       Disable push notifications
  --vapid-email <email> Contact email for VAPID (or PUSH_CONTACT_EMAIL env var)

Network Discovery Options:
  --no-mdns             Disable mDNS/Bonjour advertisement (enabled by default)

Tunnel Options:
  --ngrok               Enable ngrok tunnel for remote access
  --ngrok-auth <token>  Ngrok authentication token
  --ngrok-domain <dom>  Custom ngrok domain (requires paid plan)
  --ngrok-region <reg>  Ngrok region (us, eu, ap, au, sa, jp, in)
  --cloudflare          Enable Cloudflare tunnel (Quick Tunnel)

HQ Mode Options:
  --hq                  Run as HQ (headquarters) server

Remote Server Options:
  --hq-url <url>        HQ server URL to register with
  --hq-username <user>  Username for HQ authentication
  --hq-password <pass>  Password for HQ authentication
  --name <name>         Unique name for this remote server
  --remote-url <url>    URL the HQ uses to reach this remote (default: derived
                        from --bind, or the hostname when bound to 0.0.0.0)
  --allow-insecure-hq   Allow HTTP URLs for HQ (default: HTTPS only)
  --no-hq-auth          Disable HQ authentication (for testing only)

Environment Variables:
  PORT                  Default port if --port not specified
  UNTETHER_USERNAME, UNTETHER_PASSWORD  Set both and the password login takes this user
                        and password instead of the computer's (there are no
                        options for them: arguments are visible to every user)
  UNTETHER_LOCAL_AUTH_TOKEN Token for --allow-local-bypass (removed from the server's
                        environment at startup; never pass it on the command line)
  UNTETHER_CONTROL_DIR Control directory for session data
  UNTETHER_MAC_SESSIONS 0 or 1: "On this Mac" off or on, whatever Settings says
                        (--no-mac-sessions wins)
  UNTETHER_MAC_SESSIONS_ONLY_IN Comma-separated folders: "On this Mac" lists only what
                        runs inside them
  UNTETHER_MAC_SESSIONS_HIDE_IN Comma-separated folders: "On this Mac" leaves out what
                        runs inside them (adds to config.json's macSessionsHideIn)
  UNTETHER_MAC_SHARE  0 or 1: "Share with phone" off or on, whatever Settings says
                        (--no-mac-share wins)
  PUSH_CONTACT_EMAIL    Contact email for VAPID configuration
  NGROK_AUTHTOKEN       Ngrok auth token (used with --ngrok)

Examples:
  # Run a server; log in with this computer's user and password
  untether

  # Run with ngrok tunnel
  untether --ngrok

  # Run with Cloudflare tunnel
  untether --cloudflare

  # Run with ngrok and custom domain
  untether --ngrok --ngrok-auth TOKEN --ngrok-domain custom.ngrok.io

  # Run as HQ server, with a login of its own for the HQ
  UNTETHER_USERNAME=hq-admin UNTETHER_PASSWORD=hq-secret untether --hq

  # Run as remote server registering with HQ
  untether --hq-url https://hq.example.com \\
    --hq-username hq-admin --hq-password hq-secret \\
    --name remote-1
`;
}

export function showHelp() {
  console.log(helpText());
}

// Parse command line arguments
/** The port and address the main server listens on (the startup wait checks the same). */
export function listenPortFor(config: Config): number {
  return config.port !== null ? config.port : Number(process.env.PORT) || 4020;
}

export function bindAddressFor(config: Config): string {
  return config.bind || '0.0.0.0';
}

/** Taken once: the first parseArgs() removes it from the environment (utils/local-auth-token.ts). */
let envLocalAuthToken: string | null | undefined;

export function parseArgs(): Config {
  if (envLocalAuthToken === undefined) envLocalAuthToken = takeLocalAuthToken();
  const args = process.argv.slice(2);
  const envNgrokAuthToken = process.env.NGROK_AUTHTOKEN?.trim() || null;
  const config = {
    port: null as number | null,
    bind: null as string | null,
    previewPort: null as string | null,
    enableSSHKeys: false,
    disallowUserPassword: false,
    noAuth: false,
    unsafeNoAuthOnNetwork: false,
    isHQMode: false,
    hqUrl: null as string | null,
    hqUsername: null as string | null,
    hqPassword: null as string | null,
    remoteName: null as string | null,
    remoteUrl: null as string | null,
    allowInsecureHQ: false,
    showHelp: false,
    showVersion: false,
    debug: false,
    // Push notification configuration
    pushEnabled: true, // Enable by default with auto-generation
    vapidEmail: null as string | null,
    // Local bypass configuration
    allowLocalBypass: false,
    localAuthToken: envLocalAuthToken,
    // Tailscale Serve integration (manages auth and proxy)
    enableTailscaleServe: false,
    // Tailscale Funnel integration (public internet access)
    enableTailscaleFunnel: false,
    // HQ auth bypass for testing
    noHqAuth: false,
    // mDNS advertisement
    enableMDNS: true, // Enable mDNS by default
    // Ngrok tunnel configuration
    enableNgrok: false,
    ngrokAuthToken: envNgrokAuthToken as string | null,
    ngrokDomain: null as string | null,
    ngrokRegion: null as string | null,
    // Cloudflare tunnel configuration
    enableCloudflare: false,
    noMacSessions: false,
    noMacShare: false,
  };

  // Check for help flag first
  if (args.includes('--help') || args.includes('-h')) {
    config.showHelp = true;
    return config;
  }

  // Check for version flag
  if (args.includes('--version') || args.includes('-v')) {
    config.showVersion = true;
    return config;
  }

  // Check for command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      config.port = Number.parseInt(args[i + 1], 10);
      i++; // Skip the port value in next iteration
    } else if (args[i] === '--bind' && i + 1 < args.length) {
      config.bind = args[i + 1];
      i++; // Skip the bind value in next iteration
    } else if (args[i] === '--preview-port' && i + 1 < args.length) {
      config.previewPort = args[i + 1];
      i++;
    } else if (args[i] === '--enable-ssh-keys') {
      config.enableSSHKeys = true;
    } else if (args[i] === '--disallow-user-password') {
      config.disallowUserPassword = true;
      config.enableSSHKeys = true; // Auto-enable SSH keys
    } else if (args[i] === '--no-auth') {
      config.noAuth = true;
    } else if (args[i] === '--unsafe-no-auth-on-network') {
      config.unsafeNoAuthOnNetwork = true;
    } else if (args[i] === '--hq') {
      config.isHQMode = true;
    } else if (args[i] === '--hq-url' && i + 1 < args.length) {
      config.hqUrl = args[i + 1];
      i++; // Skip the URL value in next iteration
    } else if (args[i] === '--hq-username' && i + 1 < args.length) {
      config.hqUsername = args[i + 1];
      i++; // Skip the username value in next iteration
    } else if (args[i] === '--hq-password' && i + 1 < args.length) {
      config.hqPassword = args[i + 1];
      i++; // Skip the password value in next iteration
    } else if (args[i] === '--name' && i + 1 < args.length) {
      config.remoteName = args[i + 1];
      i++; // Skip the name value in next iteration
    } else if (args[i] === '--remote-url' && i + 1 < args.length) {
      config.remoteUrl = args[i + 1];
      i++; // Skip the URL value in next iteration
    } else if (args[i] === '--allow-insecure-hq') {
      config.allowInsecureHQ = true;
    } else if (args[i] === '--debug') {
      config.debug = true;
    } else if (args[i] === '--push-enabled') {
      config.pushEnabled = true;
    } else if (args[i] === '--push-disabled') {
      config.pushEnabled = false;
    } else if (args[i] === '--vapid-email' && i + 1 < args.length) {
      config.vapidEmail = args[i + 1];
      i++; // Skip the email value in next iteration
    } else if (args[i] === '--allow-local-bypass') {
      config.allowLocalBypass = true;
    } else if (args[i] === '--enable-tailscale-serve') {
      config.enableTailscaleServe = true;
    } else if (args[i] === '--enable-tailscale-funnel') {
      config.enableTailscaleFunnel = true;
    } else if (args[i] === '--no-hq-auth') {
      config.noHqAuth = true;
    } else if (args[i] === '--no-mdns') {
      config.enableMDNS = false;
    } else if (args[i] === '--ngrok') {
      config.enableNgrok = true;
    } else if (args[i] === '--ngrok-auth' && i + 1 < args.length) {
      config.ngrokAuthToken = args[i + 1];
      config.enableNgrok = true;
      i++; // Skip the token value in next iteration
    } else if (args[i] === '--ngrok-domain' && i + 1 < args.length) {
      config.ngrokDomain = args[i + 1];
      config.enableNgrok = true;
      i++; // Skip the domain value in next iteration
    } else if (args[i] === '--ngrok-region' && i + 1 < args.length) {
      config.ngrokRegion = args[i + 1];
      config.enableNgrok = true;
      i++; // Skip the region value in next iteration
    } else if (args[i] === '--cloudflare') {
      config.enableCloudflare = true;
    } else if (args[i] === MAC_SESSIONS_CLI_FLAG) {
      config.noMacSessions = true;
    } else if (args[i] === MAC_SHARE_CLI_FLAG) {
      config.noMacShare = true;
    } else if (args[i].startsWith('--')) {
      // Unknown argument
      logger.error(`Unknown argument: ${args[i]}`);
      logger.error('Use --help to see available options');
      process.exit(1);
    }
  }

  // Check environment variables for push notifications
  if (!config.vapidEmail && process.env.PUSH_CONTACT_EMAIL) {
    config.vapidEmail = process.env.PUSH_CONTACT_EMAIL;
  }

  // 2026-10-20 (security audit): `--no-auth` with no --bind listened on 0.0.0.0, so a test
  // server left running since Oct 18 gave anyone on the network a shell. Without --bind an
  // unauthenticated server now listens on loopback only (validateConfig refuses the rest).
  if (config.noAuth && config.bind === null) {
    config.bind = '127.0.0.1';
  }

  config.bind = bindBehindTailscaleServe(config);

  return config;
}

/**
 * The bind address once Tailscale Serve is asked for: loopback, whatever --bind said.
 *
 * 2026-11-11: with Serve on, the Mac app said "Locked to this Mac" while the server went on
 * listening on the address of the access mode (0.0.0.0 for "Network"), so the port stayed
 * open to the whole local network next to the tailnet-only HTTPS address. Serve proxies to
 * localhost: nothing else has to reach the port. A loopback address asked for is kept.
 */
export function bindBehindTailscaleServe(
  config: Pick<Config, 'bind' | 'enableTailscaleServe'>
): string | null {
  if (!config.enableTailscaleServe) return config.bind;
  return config.bind !== null && isLoopbackBindAddress(config.bind) ? config.bind : '127.0.0.1';
}

/**
 * Whether to announce the server on the local network (mDNS/Bonjour). Not when it only listens
 * on loopback: the iPhone app listed a Mac it could never connect to (2026-11-10).
 */
export function shouldAdvertiseMDNS(enableMDNS: boolean, bindAddress: string): boolean {
  return enableMDNS && !isLoopbackBindAddress(bindAddress);
}

/** Whether `address` only accepts connections from this computer. */
export function isLoopbackBindAddress(address: string): boolean {
  const host = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Why `--no-auth` must not start with this configuration, or null. Unauthenticated means a
 * shell for whoever reaches the port, so only loopback without tunnels, unless the operator
 * says otherwise with --unsafe-no-auth-on-network (2026-10-20, security audit: a --no-auth
 * test server on 0.0.0.0 was found running for two days).
 */
export function unsafeNoAuthReason(
  config: Pick<
    Config,
    | 'noAuth'
    | 'unsafeNoAuthOnNetwork'
    | 'bind'
    | 'enableNgrok'
    | 'enableCloudflare'
    | 'enableTailscaleServe'
    | 'enableTailscaleFunnel'
  >
): string | null {
  if (!config.noAuth || config.unsafeNoAuthOnNetwork) return null;
  const bind = config.bind ?? '0.0.0.0';
  if (!isLoopbackBindAddress(bind)) return `--no-auth on the network address ${bind}`;
  const tunnel = config.enableNgrok
    ? '--ngrok'
    : config.enableCloudflare
      ? '--cloudflare'
      : config.enableTailscaleFunnel
        ? '--enable-tailscale-funnel'
        : config.enableTailscaleServe
          ? '--enable-tailscale-serve'
          : null;
  return tunnel ? `--no-auth with ${tunnel}` : null;
}

/** How often an unauthenticated server checks that whoever started it is still there. */
const PARENT_WATCH_MS = 2000;

/**
 * An unauthenticated server (or any server started with UNTETHER_EXIT_WITH_PARENT=1, as the
 * test helpers do) shuts down when its parent goes away: its parent process id changes (it
 * was re-parented to launchd/init) or, in test mode, its stdin pipe closes.
 * 2026-10-20 (security audit): a `--port 0 --no-auth` server spawned by a test outlived the
 * test runner by two days (`detached: false` does not kill a child with its parent).
 * The Mac app's normal (authenticated) server is not affected.
 */
export function watchParentWhenUnauthenticated(
  config: Pick<Config, 'noAuth'>,
  onOrphaned: (why: string) => void,
  deps: {
    ppid?: () => number;
    env?: NodeJS.ProcessEnv;
    stdin?: NodeJS.ReadableStream & { fd?: number };
    stdinIsPipe?: () => boolean;
    intervalMs?: number;
  } = {}
): (() => void) | null {
  const env = deps.env ?? process.env;
  const testMode = env.UNTETHER_EXIT_WITH_PARENT === '1';
  if (!config.noAuth && !testMode) return null;
  const ppid = deps.ppid ?? (() => process.ppid);
  const startPpid = ppid();
  let fired = false;
  const fire = (why: string) => {
    if (fired) return;
    fired = true;
    stop();
    onOrphaned(why);
  };
  const timer =
    startPpid > 1
      ? every(
          'parent watch',
          () => {
            const now = ppid();
            if (now !== startPpid) fire(`parent process ${startPpid} is gone (now ${now})`);
          },
          deps.intervalMs ?? PARENT_WATCH_MS
        )
      : null;
  timer?.unref?.();
  // stdin only in test mode, and only when it is a pipe: /dev/null or a terminal would end
  // (or never end) for reasons unrelated to the parent.
  const stdin = deps.stdin ?? process.stdin;
  const stdinIsPipe =
    deps.stdinIsPipe ??
    (() => {
      try {
        const stat = fs.fstatSync(0);
        return stat.isFIFO() || stat.isSocket();
      } catch {
        return false;
      }
    });
  const onEnd = () => fire('stdin closed');
  const watchStdin = testMode && stdinIsPipe();
  if (watchStdin) {
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    stdin.resume();
    (stdin as { unref?: () => void }).unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    if (watchStdin) {
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
    }
  }
  return stop;
}

// Validate configuration
export function validateConfig(config: ReturnType<typeof parseArgs>) {
  // Validate auth configuration
  const noAuthRefusal = unsafeNoAuthReason(config);
  if (noAuthRefusal) {
    logger.error(`Refusing to start: ${noAuthRefusal} would give anyone who reaches it a shell`);
    logger.error(
      'Use --bind 127.0.0.1 without tunnels, drop --no-auth, or pass --unsafe-no-auth-on-network'
    );
    process.exit(1);
  }
  if (config.noAuth && config.unsafeNoAuthOnNetwork) {
    logger.warn(
      colors.red(
        '--unsafe-no-auth-on-network: authentication is OFF and reachable from the network'
      )
    );
  }
  if (config.noAuth && (config.enableSSHKeys || config.disallowUserPassword)) {
    logger.warn(
      '--no-auth overrides all other authentication settings (authentication is disabled)'
    );
  }

  if (config.disallowUserPassword && !config.enableSSHKeys) {
    logger.warn('--disallow-user-password requires SSH keys, auto-enabling --enable-ssh-keys');
    config.enableSSHKeys = true;
  }

  // Validate HQ registration configuration
  if (config.hqUrl && (!config.hqUsername || !config.hqPassword) && !config.noHqAuth) {
    logger.error('HQ username and password required when --hq-url is specified');
    logger.error('Use --hq-username and --hq-password with --hq-url');
    logger.error('Or use --no-hq-auth for testing without authentication');
    process.exit(1);
  }

  // Validate remote name is provided when registering with HQ
  if (config.hqUrl && !config.remoteName) {
    logger.error('Remote name required when --hq-url is specified');
    logger.error('Use --name to specify a unique name for this remote server');
    process.exit(1);
  }

  if (config.remoteUrl !== null && !config.hqUrl) {
    logger.error('--remote-url requires --hq-url');
    process.exit(1);
  }

  if (config.remoteUrl !== null) {
    try {
      config.remoteUrl = normalizeRemoteUrl(config.remoteUrl);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : 'Invalid --remote-url');
      process.exit(1);
    }
  }

  // Validate HQ URL is HTTPS unless explicitly allowed
  if (config.hqUrl && !config.hqUrl.startsWith('https://') && !config.allowInsecureHQ) {
    logger.error('HQ URL must use HTTPS protocol');
    logger.error('Use --allow-insecure-hq to allow HTTP for testing');
    process.exit(1);
  }

  // Validate HQ registration configuration
  if (
    (config.hqUrl || config.hqUsername || config.hqPassword) &&
    (!config.hqUrl || !config.hqUsername || !config.hqPassword) &&
    !config.noHqAuth
  ) {
    logger.error('All HQ parameters required: --hq-url, --hq-username, --hq-password');
    logger.error('Or use --no-hq-auth for testing without authentication');
    process.exit(1);
  }

  if (config.enableTailscaleServe) {
    logger.info(
      `Tailscale Serve integration enabled: listening on ${bindAddressFor(config)} only (bindBehindTailscaleServe)`
    );
  }

  // Can't be both HQ mode and register with HQ
  if (config.isHQMode && config.hqUrl) {
    logger.error('Cannot use --hq and --hq-url together');
    logger.error('Use --hq to run as HQ server, or --hq-url to register with an HQ');
    process.exit(1);
  }

  // Warn about no-hq-auth
  if (config.noHqAuth && config.hqUrl) {
    logger.warn('--no-hq-auth is enabled: Remote servers can register without authentication');
    logger.warn('This should only be used for testing!');
  }
}

/**
 * Why an unauthenticated server must not start on `port`: a Tailscale Serve/Funnel route still
 * forwards to it. 2026-10-20: after an unclean shutdown (killed app, crash) the persistent
 * `tailscale serve --bg` config outlived the server; a later `--no-auth` server (sign-in None)
 * on the same port was then reachable from the tailnet, or from the internet with Funnel.
 * Only read-only `tailscale serve status --json` is run (never a reset of the user's routes),
 * and not under tests unless they point at a fake Tailscale.
 */
export async function leftoverServeRoutesRefusal(
  config: Pick<Config, 'noAuth' | 'unsafeNoAuthOnNetwork' | 'enableTailscaleServe'>,
  port: number,
  routesForPort: (port: number) => Promise<string[]> = serveRoutesForPort
): Promise<string | null> {
  if (!config.noAuth || config.unsafeNoAuthOnNetwork || port === 0) return null;
  if (refusesRealTailscaleReset()) return null;
  const routes = await routesForPort(port).catch(() => []);
  if (routes.length === 0) return null;
  return [
    `Refusing to start without authentication: Tailscale still forwards to port ${port}`,
    ...routes.map((route) => `  ${route}`),
    'Remove it (`tailscale serve status`, then `tailscale serve reset` or turn that route off), or turn sign-in on.',
  ].join('\n');
}
