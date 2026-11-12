/**
 * Type definitions for Untether sessions
 */

export interface SessionInfo {
  id: string;
  name: string;
  active?: boolean;
  status?: 'running' | 'exited' | string;
  created?: string;
  startTime?: string;
  command?: string;
}
