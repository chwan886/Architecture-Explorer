import path from 'node:path';

export interface DevelopmentAppConfig {
  schemaVersion: 1;
  appId: number;
  installationId: number;
  appSlug: string;
  repository: string;
  baseBranch: string;
  keyDirectory: string;
}

export class DevelopmentAppFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export function requireApp(condition: unknown, code: string): asserts condition {
  if (!condition) throw new DevelopmentAppFailure(code);
}
export function validBranch(branch: unknown): branch is string {
  return typeof branch === 'string' && branch.length <= 255 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    !branch.startsWith('-') && !branch.includes('..') && !branch.includes('@{') && branch !== '@' &&
    branch.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}
export function validateTaskBranch(branch: unknown, baseBranch: string): asserts branch is string {
  requireApp(validBranch(branch) && branch.startsWith('codex/') && branch !== baseBranch, 'TASK_BRANCH_REQUIRED');
}

/** Configuration contains identifiers and an explicit key directory, never key or token contents. */
export function parseDevelopmentAppConfig(value: unknown): DevelopmentAppConfig {
  requireApp(value !== null && typeof value === 'object' && !Array.isArray(value), 'APP_CONFIG_INVALID');
  const config = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'appId', 'installationId', 'appSlug', 'repository', 'baseBranch', 'keyDirectory'];
  requireApp(Object.keys(config).length === fields.length && Object.keys(config).every(key => fields.includes(key)), 'APP_CONFIG_FIELDS_INVALID');
  requireApp(config.schemaVersion === 1 && Number.isSafeInteger(config.appId) && Number(config.appId) > 0 &&
    Number.isSafeInteger(config.installationId) && Number(config.installationId) > 0, 'APP_CONFIG_IDENTITY_INVALID');
  requireApp(typeof config.appSlug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(config.appSlug), 'APP_CONFIG_SLUG_INVALID');
  requireApp(typeof config.repository === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(config.repository) &&
    !config.repository.split('/')[1].endsWith('.git'), 'APP_CONFIG_REPOSITORY_INVALID');
  requireApp(validBranch(config.baseBranch) && !config.baseBranch.startsWith('codex/'), 'APP_CONFIG_BASE_INVALID');
  requireApp(typeof config.keyDirectory === 'string' && config.keyDirectory.length <= 4096 && !/[\x00-\x1f\x7f]/.test(config.keyDirectory) &&
    ((/^[A-Za-z]:[\\/]/.test(config.keyDirectory) && !config.keyDirectory.slice(2).includes(':')) ||
      (path.posix.isAbsolute(config.keyDirectory) && !config.keyDirectory.startsWith('//'))), 'APP_CONFIG_KEY_DIRECTORY_INVALID');
  return Object.freeze({ ...config }) as unknown as DevelopmentAppConfig;
}
