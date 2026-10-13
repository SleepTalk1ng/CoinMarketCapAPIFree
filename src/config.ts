export interface AppConfig {
  readonly serviceApiKey: string;
  readonly cmcApiKey: string;
  readonly port: number;
  readonly databasePath: string;
  readonly cmcTimeoutMs: number;
  readonly syncIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Invalid configuration: ${message}`);
    this.name = 'ConfigurationError';
  }
}

const MAX_TIMER_MS = 2_147_483_647;

function requiredKey(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !/^[\x21-\x7e]+$/.test(value)) {
    throw new ConfigurationError(`${name} must be a non-empty key without whitespace.`);
  }
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ConfigurationError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const serviceApiKey = requiredKey(env, 'SERVICE_API_KEY');
  const cmcApiKey = requiredKey(env, 'CMC_API_KEY');
  if (serviceApiKey === cmcApiKey) {
    throw new ConfigurationError('SERVICE_API_KEY and CMC_API_KEY must be different.');
  }

  const databasePath = (env.DATABASE_PATH ?? './data/app.sqlite').trim();
  if (!databasePath || databasePath.includes('\0') || databasePath === ':memory:' || /^file:/i.test(databasePath)) {
    throw new ConfigurationError('DATABASE_PATH must be a non-empty filesystem path, not an in-memory database or URI.');
  }

  return {
    serviceApiKey,
    cmcApiKey,
    port: positiveInteger(env, 'PORT', 3000, 65_535),
    databasePath,
    cmcTimeoutMs: positiveInteger(env, 'CMC_TIMEOUT_MS', 5000, MAX_TIMER_MS),
    syncIntervalMs: positiveInteger(env, 'SYNC_INTERVAL_MS', 60_000, MAX_TIMER_MS),
    shutdownTimeoutMs: positiveInteger(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, MAX_TIMER_MS),
  };
}
