import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ValidatedReleasePlan } from '../Tools/ci-release-evidence.ts';
import type { ReleasePublishHttpRequest, ReleasePublishRequest } from '../Tools/ci-release-publish.ts';
const repository = 'chwan886/Architecture-Explorer', api = `https://api.github.com/repos/${repository}`;
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
type Json = Record<string, any>;
// Offline API observations only; importing this helper never registers or runs a test.
export function releasePublisherFixture(plan: Pick<ValidatedReleasePlan, 'toolSha' | 'tagName'>) {
  const state: { release?: Json; extraReleases: Json[]; assets: Json[]; calls: ReleasePublishHttpRequest[];
    private: boolean; protected: boolean; main: string; tag: 'absent' | 'commit' | 'annotated' | 'wrong'; failUploadOnce: string | undefined;
    starterOnFailure: boolean; failCreate: boolean; wrongUploadDigest: boolean; listPageFillers: boolean; duplicateRelease: boolean; publishAfterLastUpload: boolean;
  } = { extraReleases: [], assets: [], calls: [], private: true, protected: true, main: plan.toolSha, tag: 'absent', failUploadOnce: undefined,
    starterOnFailure: false, failCreate: false, wrongUploadDigest: false, listPageFillers: false, duplicateRelease: false, publishAfterLastUpload: false };
  let nextAsset = 200;
  const request: ReleasePublishRequest = async input => {
    state.calls.push(input);
    const url = new URL(input.url);
    assert.ok(['https://api.github.com', 'https://uploads.github.com'].includes(url.origin));
    assert.ok(url.pathname === '/users/github-actions%5Bbot%5D' || url.pathname.startsWith(`/repos/${repository}`));
    assert.ok(!url.pathname.includes('GameDemo02'));
    assert.ok(['GET', 'POST'].includes(input.method));
    if (input.json) {
      assert.notEqual(input.json.draft, false); assert.notEqual(input.json.make_latest, true);
      assert.ok(!Object.hasOwn(input.json, 'force') && !Object.hasOwn(input.json, 'discussion_category_name'));
    }
    if (input.method === 'GET' && input.url === 'https://api.github.com/users/github-actions%5Bbot%5D') return { status: 200, data: structuredClone(bot) };
    if (input.method === 'GET' && input.url === api) return { status: 200, data: { id: 7001, full_name: repository, private: state.private, visibility: state.private ? 'private' : 'public', default_branch: 'main', archived: false, disabled: false } };
    if (input.method === 'GET' && input.url === `${api}/branches/main`) return { status: 200, data: { name: 'main', protected: state.protected, commit: { sha: state.main } } };
    if (input.method === 'GET' && input.url === `${api}/git/ref/heads/main`) return { status: 200, data: { ref: 'refs/heads/main', object: { type: 'commit', sha: state.main } } };
    if (input.method === 'GET' && input.url === `${api}/git/ref/tags/${plan.tagName}`) {
      if (state.tag === 'absent') return { status: 404 };
      return { status: 200, data: { ref: `refs/tags/${plan.tagName}`, object: {
        type: state.tag === 'annotated' ? 'tag' : 'commit', sha: state.tag === 'annotated' ? '9'.repeat(40) : state.tag === 'wrong' ? '8'.repeat(40) : plan.toolSha,
      } } };
    }
    if (input.method === 'GET' && input.url === `${api}/git/tags/${'9'.repeat(40)}`) return { status: 200, data: { sha: '9'.repeat(40), object: { type: 'commit', sha: plan.toolSha } } };
    if (input.method === 'GET' && url.pathname === `/repos/${repository}/releases`) {
      const page = Number(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('per_page'), '100');
      if (state.listPageFillers && page === 1) return { status: 200, data: Array.from({ length: 100 }, (_, index) => ({ id: index + 1000, tag_name: `other-${index}` })) };
      const data = [...state.extraReleases, ...(state.release ? [state.release] : []), ...(state.release && state.duplicateRelease ? [state.release] : [])];
      return { status: 200, data: structuredClone(data) };
    }
    if (input.method === 'POST' && input.url === `${api}/releases`) {
      assert.equal(input.json?.draft, true); assert.equal(input.json?.prerelease, true); assert.equal(input.json?.generate_release_notes, false); assert.equal(input.json?.make_latest, 'false');
      assert.equal(input.json?.tag_name, plan.tagName); assert.equal(input.json?.target_commitish, plan.toolSha);
      assert.match(String(input.json?.body), /^DRAFT — producer inputs validated; assets may still be incomplete/);
      if (state.failCreate) throw Error('untrusted fixture error reflects bearer-secret');
      assert.equal(state.release, undefined, 'never issue a second creation for the same producer');
      state.release = { ...input.json, id: 100, author: structuredClone(bot), published_at: null,
        url: `${api}/releases/100`, html_url: `https://github.com/${repository}/releases/tag/untagged-fixture-100`,
        assets_url: `${api}/releases/100/assets`, upload_url: `https://uploads.github.com/repos/${repository}/releases/100/assets{?name,label}` };
      return { status: 201, data: structuredClone(state.release) };
    }
    if (input.method === 'GET' && input.url === `${api}/releases/100`) return { status: 200, data: structuredClone(state.release) };
    if (input.method === 'GET' && url.pathname === `/repos/${repository}/releases/100/assets`) return { status: 200, data: structuredClone(state.assets) };
    if (input.method === 'POST' && url.origin === 'https://uploads.github.com') {
      assert.equal(url.pathname, `/repos/${repository}/releases/100/assets`);
      const name = url.searchParams.get('name')!;
      assert.ok(input.bytes instanceof Uint8Array); assert.ok(input.contentType === 'application/zip' || input.contentType === 'application/json');
      assert.equal(state.assets.some(asset => asset.name === name), false, 'never overwrite an existing name');
      const asset = { id: nextAsset++, name, state: 'uploaded', size: input.bytes.length,
        digest: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`, uploader: structuredClone(bot) } as Json;
      asset.url = `${api}/releases/assets/${asset.id}`;
      if (name === state.failUploadOnce) {
        state.failUploadOnce = undefined;
        if (state.starterOnFailure) state.assets.push({ ...asset, state: 'starter', size: 0, digest: null });
        return { status: 502 };
      }
      if (state.wrongUploadDigest) asset.digest = `sha256:${'f'.repeat(64)}`;
      state.assets.push(asset);
      if (state.publishAfterLastUpload && state.assets.length === 3) { state.release!.draft = false; state.release!.published_at = '2026-10-22T01:00:00Z'; }
      return { status: 201, data: structuredClone(asset) };
    }
    throw Error(`Unexpected fixture route ${input.method} ${url.pathname}`);
  };
  const writes = () => state.calls.filter(call => call.method !== 'GET');
  return { state, request, writes };
}
