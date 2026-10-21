import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'chwan886/Architecture-Explorer';
export interface ArtifactRepository {
  full_name: string;
  default_branch: string;
  private: boolean;
  visibility: string;
}
export type ReadArtifactRepository = (repository: string) => Promise<ArtifactRepository>;

/** The package includes committed game quotes. Private visibility alone is not audience approval. */
export function artifactAccessInput(env: NodeJS.ProcessEnv) {
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Unexpected tool repository');
  assert.equal(env.GITHUB_SERVER_URL, 'https://github.com', 'Unsupported GitHub host');
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Tool package delivery only accepts a main push');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Tool package delivery requires main');
  assert.equal(env.GITHUB_REF_PROTECTED, 'true', 'Tool package delivery requires protected main');
  assert.equal(env.INDEX_ACCESS_APPROVED, 'true', 'Game audience review is required for the repository, reports and tool package');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'Exact tool SHA required');
  return { repository, toolSha: env.GITHUB_SHA! };
}

export async function authorizeArtifactAccess(env: NodeJS.ProcessEnv, readRepository: ReadArtifactRepository) {
  const input = artifactAccessInput(env);
  const metadata = await readRepository(input.repository);
  assert.equal(metadata.full_name, input.repository, 'Repository identity mismatch');
  assert.equal(metadata.default_branch, 'main', 'Tool default branch must remain main');
  assert.equal(metadata.private, true, 'Game excerpts require a private tool repository');
  assert.equal(metadata.visibility, 'private', 'Game excerpts require private artifact storage');
  return {
    schemaVersion: 1,
    repository: input.repository,
    toolSha: input.toolSha,
    containsGameSourceExcerpts: true,
    sourceGameRepository: 'chwan886/GameDemo02',
    audienceReview: 'Manually approved through the main-only protected Environment; repository, logs, reports and packages must not exceed the game reader audience.',
    repositoryVisibility: metadata.visibility,
    authorizedAt: new Date().toISOString(),
  };
}

async function main() {
  const result = await authorizeArtifactAccess(process.env, async requested => {
    const token = process.env.TOOL_ARTIFACT_READ_TOKEN;
    assert.ok(token, 'Missing own-repository read token');
    const response = await fetch(`https://api.github.com/repos/${requested}`, {
      redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    assert.ok(response.ok, `Own-repository metadata read failed: HTTP ${response.status}`);
    return response.json();
  });
  await mkdir('.ci-output/artifact-access', { recursive: true });
  await writeFile('.ci-output/artifact-access/authorization.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'artifact_access=allowed\n');
  console.log('Private tool repository and protected-main audience approval verified for package delivery.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
