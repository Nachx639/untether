import * as os from 'os';
import * as path from 'path';
import {
  type TunnelInfo,
  type TunnelOutputSource,
  TunnelServiceBase,
} from './tunnel-service-base.js';

export interface NgrokConfig {
  authToken?: string;
  domain?: string;
  port: number;
  region?: string;
}

export class NgrokService extends TunnelServiceBase {
  private authToken?: string;
  private domain?: string;
  private region?: string;

  constructor(config: NgrokConfig) {
    super('ngrok-service', config.port);
    this.authToken = config.authToken;
    this.domain = config.domain;
    this.region = config.region;
  }

  protected getServiceName(): string {
    return 'ngrok';
  }

  protected getProcessName(): string {
    return 'ngrok';
  }

  protected getBinaryPaths(): string[] {
    return [
      'ngrok', // Global PATH
      '/usr/local/bin/ngrok',
      '/opt/homebrew/bin/ngrok',
      path.join(os.homedir(), '.local', 'bin', 'ngrok'),
    ];
  }

  protected getBinaryVersionArgs(): string[] {
    return ['version'];
  }

  protected getBinaryNotFoundMessage(): string {
    return 'ngrok binary not found. Please install ngrok: https://ngrok.com/download';
  }

  protected getStartupTimeoutMessage(): string {
    return 'Ngrok startup timeout - tunnel failed to start';
  }

  protected buildStartArgs(): string[] {
    const args = ['http', String(this.port), '--log=stdout', '--log-format=json'];

    if (this.domain) {
      args.push('--domain', this.domain);
    }

    if (this.region) {
      args.push('--region', this.region);
    }

    return args;
  }

  /**
   * 2026-11-11: the authtoken went as `--authtoken <token>`, which every user of the Mac reads
   * with `ps -ww` (the leak fixed for the local auth token on 2026-10-27 and for the Mac app's
   * own ngrok on 2026-11-07). ngrok reads it from NGROK_AUTHTOKEN.
   */
  protected buildStartEnv(): Record<string, string> {
    return this.authToken ? { NGROK_AUTHTOKEN: this.authToken } : {};
  }

  protected parseOutput(output: string, source: TunnelOutputSource): string | null {
    if (source === 'stderr') {
      this.logger.error('Ngrok stderr:', output);
      return null;
    }

    const lines = output.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const log = JSON.parse(line);

        if (log.msg === 'started tunnel' && log.url) {
          return log.url;
        }

        if (log.lvl === 'error' || log.err) {
          this.logger.error('Ngrok error:', log.err || log.msg);
        }
      } catch {
        this.logger.debug('Ngrok output:', line);
      }
    }

    return null;
  }

  protected createTunnelInfo(publicUrl: string): TunnelInfo {
    return {
      publicUrl,
      proto: 'http',
      name: 'command_line',
      uri: `http://localhost:${this.port}`,
    };
  }
}
