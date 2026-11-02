import type { Bindings } from './platform';
import type { AppConfig } from './config';
import type { Settings } from './settings';
import type { Logger } from './utils/logger';
import type { AuthUser } from './auth/types';

export interface AppVariables {
  requestId: string;
  logger: Logger;
  config: AppConfig;
  settings: Settings;
  ip: string;
  user?: AuthUser;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};

export type { Bindings };
