import { createHash } from 'node:crypto';
import { isValidatedReleasePlan, type ValidatedReleasePlan } from './ci-release-evidence.ts';

const repository = 'chwan886/Architecture-Explorer';
const api = `https://api.github.com/repos/${repository}`;
const botLogin = 'github-actions[bot]';
type Json = Record<string, any>;
export interface ReleasePublishHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  json?: Readonly<Record<string, unknown>>;
  bytes?: Uint8Array;
  contentType?: 'application/zip' | 'application/json';
}
/** Trusted transport supplies only the publisher job's GITHUB_TOKEN. This module never accepts a credential. */
export type ReleasePublishRequest = (request: ReleasePublishHttpRequest) => Promise<{ status: number; data?: unknown }>;
export interface PublisherContext { runId: string; runAttempt: string; runUrl: string }
export interface PublishedAssetReceipt {
  id: number; name: string; size: number; sha256: string; state: 'uploaded'; action: 'uploaded' | 'reused';
}
export interface DraftReleaseReceipt {
  schemaVersion: '1.0.0';
  outcome: 'passed' | 'failed';
  repository: typeof repository;
  draftOnly: true;
  complete: boolean;
  publisher?: Readonly<PublisherContext>;
  binding?: { toolSha: string; gameSha: string; producerRunId: string; producerRunAttempt: string; fingerprint: string; tagName: string };
  release?: { id: number; htmlUrl: string; tagName: string; targetCommitish: string; draft: boolean; publishedAt: string | null };
  observedReleaseState?: { id: number; draft: boolean; publishedAt: string | null; ownedDraftVerified: boolean };
  assets: PublishedAssetReceipt[];
  releaseCreation: 'not-attempted' | 'unconfirmed' | 'confirmed' | 'reused';
  failureCode?: string;
  failureObservation?: 'unavailable' | 'owned-draft-rechecked';
  forbiddenRequests: { publish: false; updateRelease: false; delete: false; overwriteAsset: false; writeGitRef: false; gameRepositoryWrite: false; useDevelopmentApp: false };
}
interface Upload { name: string; size: number; sha256: string; bytes: Buffer; contentType: 'application/zip' | 'application/json' }
class PublishFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function need(value: unknown, code: string): asserts value { if (!value) throw new PublishFailure(code); }
function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function id(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value); }
function positiveRun(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.exec(value)?.[0] === value; }
function releaseLink(value: unknown): value is string {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash &&
      new RegExp(`^/${repository}/releases/(?:tag/[A-Za-z0-9._-]+|edit/[1-9][0-9]*|[1-9][0-9]*)$`).test(url.pathname);
  } catch { return false; }
}
function uploads(plan: ValidatedReleasePlan, supplied: ReadonlyMap<string, Uint8Array>): Upload[] {
  need(supplied instanceof Map && supplied.size === 2, 'EXACT_TWO_ZIP_BYTES_REQUIRED');
  const references = [...plan.assets.map(asset => ({ ...asset, contentType: 'application/zip' as const })),
    { ...plan.releaseManifestAsset, contentType: 'application/json' as const }];
  const names = new Set<string>();
  return references.map(pin => {
    need(typeof pin.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(pin.name) && !pin.name.includes('..') &&
      !pin.name.endsWith('.') && !names.has(pin.name.toLowerCase()), 'ASSET_NAME_INVALID_OR_DUPLICATE');
    names.add(pin.name.toLowerCase());
    const suppliedBytes = pin.name === 'release-manifest.json' ? Buffer.from(plan.releaseManifestJson, 'utf8') : supplied.get(pin.name);
    need(suppliedBytes instanceof Uint8Array, 'ASSET_BYTES_MISSING');
    // Own the bytes for the entire attempt; a caller cannot mutate a verified buffer during an async request.
    const bytes = Buffer.from(suppliedBytes);
    need(Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 2 * 1024 ** 3 && bytes.length === pin.size &&
      /^[a-f0-9]{64}$/.test(pin.sha256) && sha256(bytes) === pin.sha256, 'ASSET_BYTES_PIN_MISMATCH');
    return { name: pin.name, size: pin.size, sha256: pin.sha256, bytes, contentType: pin.contentType };
  });
}
function body(plan: ValidatedReleasePlan, assets: readonly Upload[]): string {
  return [
    'DRAFT — producer inputs validated; assets may still be incomplete. Publish manually only after a publisher job succeeds.',
    '', `<!-- architecture-explorer-release-binding:v1:${plan.bindingFingerprint} -->`,
    `Tool SHA: ${plan.toolSha}`, `Game SHA: ${plan.gameSha}`,
    `Producer: https://github.com/${repository}/actions/runs/${plan.producerRunId}/attempts/${plan.producerRunAttempt}`,
    `Producer run and current attempt/job results: https://github.com/${repository}/actions/runs/${plan.producerRunId}`,
    '', 'Private Architecture Explorer tool package and exact Game SHA index snapshot. Contains source excerpts; keep the existing private audience.',
    'This is a tool delivery draft, not a Game release or proof of Unity Full. The index snapshot is not a local cache installer.',
    '', ...assets.map(asset => `- ${asset.name}: ${asset.size} bytes; SHA256 ${asset.sha256}`), '',
  ].join('\n');
}
function title(plan: ValidatedReleasePlan) { return `Architecture Explorer ${plan.toolSha.slice(0, 12)} / Game ${plan.gameSha.slice(0, 12)}`; }

/** Only draft creation and missing assets are written. Never PATCH/DELETE or publish, including an existing release. */
export async function publishReleaseDraft(plan: ValidatedReleasePlan, supplied: ReadonlyMap<string, Uint8Array>,
  request: ReleasePublishRequest, publisher: PublisherContext): Promise<DraftReleaseReceipt> {
  const receipt: DraftReleaseReceipt = { schemaVersion: '1.0.0', outcome: 'failed', repository, draftOnly: true, complete: false, assets: [],
    releaseCreation: 'not-attempted',
    forbiddenRequests: { publish: false, updateRelease: false, delete: false, overwriteAsset: false, writeGitRef: false, gameRepositoryWrite: false, useDevelopmentApp: false } };
  let releaseId: number | undefined, botId: number | undefined, assetInputs: Upload[] = [], stableBody = '';
  const call = async (input: ReleasePublishHttpRequest, expectedStatus: number, code: string): Promise<any> => {
    const response = await request(input);
    need(response.status === expectedStatus, code);
    return response.data;
  };
  const get = async (endpoint: string, code: string) => await call({ method: 'GET', url: `${api}${endpoint}` }, 200, code);
  const list = async (endpoint: string, code: string): Promise<Json[]> => {
    const found: Json[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await get(`${endpoint}?per_page=100&page=${page}`, code);
      need(Array.isArray(data) && data.length <= 100 && data.every(value => value && typeof value === 'object' && !Array.isArray(value)), `${code}_SHAPE`);
      found.push(...data);
      if (data.length < 100) return found;
    }
    throw new PublishFailure(`${code}_PAGINATION_LIMIT`);
  };
  const verifyTag = async () => {
    const response = await request({ method: 'GET', url: `${api}/git/ref/tags/${plan.tagName}` });
    if (response.status === 404) return;
    need(response.status === 200, 'TAG_READ_FAILED');
    const ref = response.data as Json;
    need(ref?.ref === `refs/tags/${plan.tagName}`, 'TAG_IDENTITY_MISMATCH');
    let object = ref.object;
    const visited = new Set<string>();
    for (let depth = 0; depth < 10; depth++) {
      need(object && sha(object.sha), 'TAG_OBJECT_INVALID');
      if (object.type === 'commit') { need(object.sha === plan.toolSha, 'TAG_TARGET_CONFLICT'); return; }
      need(object.type === 'tag' && !visited.has(object.sha), 'TAG_PEEL_INVALID');
      visited.add(object.sha);
      const annotation = await get(`/git/tags/${object.sha}`, 'ANNOTATED_TAG_READ_FAILED');
      need(annotation?.sha === object.sha, 'ANNOTATED_TAG_IDENTITY_MISMATCH');
      object = annotation.object;
    }
    throw new PublishFailure('TAG_PEEL_LIMIT');
  };
  const guard = async () => {
    const repo = await get('', 'REPOSITORY_READ_FAILED');
    need(repo?.full_name === repository && repo.private === true && repo.default_branch === 'main' &&
      repo.archived === false && repo.disabled === false, 'PRIVATE_MAIN_REPOSITORY_REQUIRED');
    const branch = await get('/branches/main', 'MAIN_BRANCH_READ_FAILED');
    need(branch?.name === 'main' && branch.protected === true, 'PROTECTED_MAIN_REQUIRED');
    need(branch.commit?.sha === plan.toolSha, 'TOOL_MAIN_ADVANCED_OR_MISMATCHED');
    const ref = await get('/git/ref/heads/main', 'MAIN_REF_READ_FAILED');
    need(ref?.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === plan.toolSha, 'TOOL_MAIN_ADVANCED_OR_MISMATCHED');
    await verifyTag();
  };
  const verifyRelease = (value: Json, expectedId?: number) => {
    need(value && id(value.id) && (expectedId === undefined || value.id === expectedId) && value.tag_name === plan.tagName &&
      value.target_commitish === plan.toolSha && value.name === title(plan), 'RELEASE_IDENTITY_OR_TARGET_CONFLICT');
    need(value.draft === true && value.published_at === null && value.prerelease === true, 'RELEASE_ALREADY_PUBLISHED_OR_NOT_DRAFT');
    need(value.author?.login === botLogin && value.author?.type === 'Bot' && value.author?.id === botId, 'RELEASE_AUTHOR_CONFLICT');
    need(value.body === stableBody, 'RELEASE_BINDING_CONFLICT');
    need(releaseLink(value.html_url) && value.url === `${api}/releases/${value.id}` &&
      value.assets_url === `${api}/releases/${value.id}/assets` &&
      value.upload_url === `https://uploads.github.com/repos/${repository}/releases/${value.id}/assets{?name,label}`, 'RELEASE_URL_CONFLICT');
    return { id: value.id as number, htmlUrl: value.html_url as string, tagName: value.tag_name as string,
      targetCommitish: value.target_commitish as string, draft: value.draft as boolean, publishedAt: null };
  };
  const readRelease = async () => {
    need(releaseId !== undefined, 'RELEASE_ID_REQUIRED');
    const value = await get(`/releases/${releaseId}`, 'DRAFT_RECHECK_FAILED');
    if (value?.id === releaseId && typeof value.draft === 'boolean' && (value.published_at === null ||
      (typeof value.published_at === 'string' && value.published_at.length <= 64 && Number.isFinite(Date.parse(value.published_at))))) {
      receipt.observedReleaseState = { id: releaseId, draft: value.draft, publishedAt: value.published_at, ownedDraftVerified: false };
    }
    receipt.release = verifyRelease(value, releaseId);
    receipt.observedReleaseState = { id: releaseId, draft: true, publishedAt: null, ownedDraftVerified: true };
    return value;
  };
  const verifyAsset = (value: Json, pin: Upload, action: 'uploaded' | 'reused'): PublishedAssetReceipt => {
    need(value && id(value.id) && value.name === pin.name && value.state === 'uploaded' && value.size === pin.size &&
      value.digest === `sha256:${pin.sha256}`, 'ASSET_STATE_SIZE_OR_DIGEST_CONFLICT');
    need(value.url === `${api}/releases/assets/${value.id}` && value.uploader?.id === botId &&
      value.uploader?.login === botLogin && value.uploader?.type === 'Bot', 'ASSET_IDENTITY_OR_AUTHOR_CONFLICT');
    return { id: value.id, name: pin.name, size: pin.size, sha256: pin.sha256, state: 'uploaded', action };
  };
  const readAssets = async (): Promise<Map<string, Json>> => {
    const values = await list(`/releases/${releaseId}/assets`, 'ASSET_LIST_FAILED');
    const found = new Map<string, Json>(), ids = new Set<number>(), names = new Set<string>();
    for (const asset of values) {
      const pin = assetInputs.find(pin => pin.name === asset.name);
      need(pin && typeof asset.name === 'string' && !names.has(asset.name.toLowerCase()) && !ids.has(asset.id), 'UNEXPECTED_OR_DUPLICATE_ASSET');
      verifyAsset(asset, pin, 'reused');
      found.set(asset.name, asset); names.add(asset.name.toLowerCase()); ids.add(asset.id);
    }
    return found;
  };
  try {
    need(isValidatedReleasePlan(plan) && Object.isFrozen(plan), 'VALIDATED_FROZEN_PLAN_REQUIRED');
    need(plan.repository === repository && plan.kind === 'architecture-explorer-private-tool-release-draft' && sha(plan.toolSha) && sha(plan.gameSha) &&
      /^[1-9]\d{0,19}$/.test(plan.producerRunId) && /^[1-9]\d{0,19}$/.test(plan.producerRunAttempt) &&
      /^[a-f0-9]{64}$/.test(plan.bindingFingerprint) &&
      plan.tagName === `ae-tool-${plan.toolSha}-game-${plan.gameSha}-r${plan.producerRunId}-a${plan.producerRunAttempt}`, 'PLAN_BINDING_INVALID');
    need(publisher && publisher.runId === plan.producerRunId && positiveRun(publisher.runAttempt) &&
      BigInt(publisher.runAttempt) >= BigInt(plan.producerRunAttempt) &&
      publisher.runUrl === `https://github.com/${repository}/actions/runs/${publisher.runId}/attempts/${publisher.runAttempt}`, 'PUBLISHER_CONTEXT_INVALID');
    receipt.publisher = Object.freeze({ ...publisher });
    receipt.binding = { toolSha: plan.toolSha, gameSha: plan.gameSha, producerRunId: plan.producerRunId,
      producerRunAttempt: plan.producerRunAttempt, fingerprint: plan.bindingFingerprint, tagName: plan.tagName };
    assetInputs = uploads(plan, supplied);
    stableBody = body(plan, assetInputs);
    await guard();
    const bot = await call({ method: 'GET', url: 'https://api.github.com/users/github-actions%5Bbot%5D' }, 200, 'ACTIONS_BOT_READ_FAILED');
    need(bot?.login === botLogin && bot.type === 'Bot' && id(bot.id), 'ACTIONS_BOT_IDENTITY_INVALID'); botId = bot.id;
    const matching = (await list('/releases', 'RELEASE_LIST_FAILED')).filter(release => release.tag_name === plan.tagName);
    need(matching.length <= 1, 'AMBIGUOUS_EXISTING_RELEASE');
    if (matching.length === 1) {
      const existing = verifyRelease(matching[0]); releaseId = existing.id; receipt.releaseCreation = 'reused';
      await readRelease();
    } else {
      await guard();
      receipt.releaseCreation = 'unconfirmed';
      const created = await call({ method: 'POST', url: `${api}/releases`, json: {
        tag_name: plan.tagName, target_commitish: plan.toolSha, name: title(plan), body: stableBody,
        draft: true, prerelease: true, generate_release_notes: false, make_latest: 'false',
      } }, 201, 'DRAFT_CREATION_UNCONFIRMED');
      const checked = verifyRelease(created); releaseId = checked.id; receipt.release = checked; receipt.releaseCreation = 'confirmed';
      await readRelease();
    }
    let existing = await readAssets();
    for (const pin of assetInputs) {
      const known = existing.get(pin.name);
      if (known) { receipt.assets.push(verifyAsset(known, pin, 'reused')); continue; }
      await guard(); await readRelease();
      // Re-read after the draft check: never overwrite or race an existing name, including a starter asset.
      existing = await readAssets();
      const appeared = existing.get(pin.name);
      if (appeared) { receipt.assets.push(verifyAsset(appeared, pin, 'reused')); continue; }
      await readRelease();
      const uploaded = await call({ method: 'POST',
        url: `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(pin.name)}`,
        bytes: pin.bytes, contentType: pin.contentType,
      }, 201, 'ASSET_UPLOAD_UNCONFIRMED');
      receipt.assets.push(verifyAsset(uploaded, pin, 'uploaded'));
    }
    await guard(); await readRelease();
    const finalAssets = await readAssets();
    need(finalAssets.size === assetInputs.length, 'FINAL_ASSET_SET_INCOMPLETE');
    for (const pin of assetInputs) {
      const verified = verifyAsset(finalAssets.get(pin.name)!, pin, 'reused');
      need(receipt.assets.find(asset => asset.name === pin.name)?.id === verified.id, 'FINAL_ASSET_ID_CHANGED');
    }
    await guard(); await readRelease();
    const recheckedAssets = await readAssets();
    need(recheckedAssets.size === assetInputs.length && receipt.assets.every(asset =>
      recheckedAssets.get(asset.name)?.id === asset.id), 'FINAL_DRAFT_RECHECK_FAILED');
    receipt.complete = true; receipt.outcome = 'passed';
  } catch (error) {
    receipt.failureCode = error instanceof PublishFailure ? error.code : 'DRAFT_PUBLISHER_REQUEST_OR_INTERNAL_FAILURE';
    // Keep a truthful red receipt for a real partial draft; never repair by deleting assets or republishing.
    if (releaseId !== undefined && botId !== undefined) {
      try { await readRelease(); await readAssets(); receipt.failureObservation = 'owned-draft-rechecked'; }
      catch { receipt.failureObservation = 'unavailable'; }
    }
  }
  return receipt;
}
