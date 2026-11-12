/** The config.json a new install starts from. */

import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import { DEFAULT_QUICK_START_COMMANDS } from './quick-start.js';
import type { UntetherConfig } from './untether-config.js';

export const DEFAULT_CONFIG: UntetherConfig = {
  version: 2,
  quickStartCommands: DEFAULT_QUICK_START_COMMANDS,
  repositoryBasePath: DEFAULT_REPOSITORY_BASE_PATH,
};
