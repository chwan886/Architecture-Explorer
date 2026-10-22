/** Metadata observation only: this does not download, upload or approve a dependency. */
export const unityDependencyRepository = 'chwan886/Architecture-Explorer' as const;
export const unityDependencyTag = 'unity-references-6000.6.5f1-win64-dev-v1' as const;
export const unityDependencyAssetName = 'unity-6000.6.5f1-win64-development-metadata.zip' as const;
const prefix = `/repos/${unityDependencyRepository}`;
const endpoint = `${prefix}/releases/tags/${unityDependencyTag}`;
const htmlUrl = `https://github.com/${unityDependencyRepository}/releases/tag/${unityDependencyTag}`;
type MetadataRequest = (method: 'GET', endpoint: string, credential: string) => Promise<{ status: number; data?: unknown }>;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const safeDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, '.000Z');

/** The caller supplies its existing single-Tool-repository Contents-read session. */
export async function inspectUnityDependencyRelease(token: string, request: MetadataRequest) {
  const base = { repository: unityDependencyRepository, tagName: unityDependencyTag, metadataOnly: true as const,
    artifactBytesVerified: false as const, expectedAssetName: unityDependencyAssetName };
  let response: { status: number; data?: unknown };
  try { response = await request('GET', endpoint, token); }
  catch { return { ...base, status: 'unreadable' as const, failureCode: 'DEPENDENCY_RELEASE_REQUEST_FAILED' }; }
  if (!response || typeof response !== 'object' || !Number.isInteger(response.status))
    return { ...base, status: 'unreadable' as const, failureCode: 'DEPENDENCY_RELEASE_HTTP_FAILED' };
  if (response.status === 404) return { ...base, status: 'not-found' as const, httpStatus: 404 as const };
  if (response.status !== 200) return { ...base, status: 'unreadable' as const, failureCode: 'DEPENDENCY_RELEASE_HTTP_FAILED',
    ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? { httpStatus: response.status } : {}) };
  try {
    const release = response.data as Record<string, any>;
    const safeText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
      !/[\x00-\x1f\x7f]/.test(value) && !value.includes(token);
    if (!token || !release || typeof release !== 'object' || Array.isArray(release) || !positiveId(release.id) ||
      release.tag_name !== unityDependencyTag || release.html_url !== htmlUrl ||
      release.url !== `https://api.github.com${prefix}/releases/${release.id}` ||
      (release.name !== null && !safeText(release.name)) || typeof release.draft !== 'boolean' ||
      (release.published_at !== null && !safeDate(release.published_at)) ||
      (release.draft ? release.published_at !== null : release.published_at === null) ||
      !Array.isArray(release.assets) || release.assets.length > 100) throw Error();
    const ids = new Set<number>(), names = new Set<string>();
    const assets = release.assets.map((asset: Record<string, any>) => {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset) || !positiveId(asset.id) || ids.has(asset.id) ||
        !safeText(asset.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) || names.has(asset.name.toLowerCase()) ||
        asset.url !== `https://api.github.com${prefix}/releases/assets/${asset.id}` ||
        !Number.isSafeInteger(asset.size) || asset.size < 0 || !['uploaded', 'open', 'starter'].includes(asset.state) ||
        (asset.digest !== null && !(typeof asset.digest === 'string' && asset.digest.length === 71 && /^sha256:[a-f0-9]{64}$/.test(asset.digest)))) throw Error();
      ids.add(asset.id); names.add(asset.name.toLowerCase());
      return { id: asset.id as number, name: asset.name as string, sizeBytes: asset.size as number,
        digest: asset.digest as string | null, state: asset.state as 'uploaded' | 'open' | 'starter' };
    });
    return { ...base, status: 'found' as const, release: { id: release.id as number, name: release.name as string | null,
      draft: release.draft as boolean, published: !release.draft && release.published_at !== null,
      publishedAt: release.published_at as string | null, htmlUrl }, assets,
      expectedAsset: assets.find(asset => asset.name === unityDependencyAssetName) ?? null };
  } catch { return { ...base, status: 'unreadable' as const, failureCode: 'DEPENDENCY_RELEASE_METADATA_INVALID' }; }
}
