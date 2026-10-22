import test from 'node:test';
import assert from 'node:assert/strict';
import { githubApiVersion } from '../Tools/github-api-version.ts';

const head = 'a'.repeat(40);

test('only fixed-repository PR provenance reads use the supported merge SHA response contract', () => {
  for (const repository of ['chwan886/Architecture-Explorer', 'chwan886/GameDemo02']) {
    for (const path of ['/pulls/1', '/pulls/123456', `/commits/${head}/pulls`]) {
      for (const query of ['', '?page=1&per_page=100', '?per_page=1&page=20']) {
        assert.equal(githubApiVersion('GET', `/repos/${repository}${path}${query}`), '2022-11-28');
      }
    }
  }
});

test('dispatch, PR writes, review reads, authentication and other resources keep REST 2026 semantics', () => {
  const prefix = '/repos/chwan886/Architecture-Explorer';
  for (const [method, endpoint] of [
    ['POST', `${prefix}/actions/workflows/game-index.yml/dispatches`],
    ['POST', `${prefix}/pulls`], ['PATCH', `${prefix}/pulls/1`], ['DELETE', `${prefix}/pulls/1`],
    ['GET', `${prefix}/pulls/1/reviews?per_page=100&page=1`], ['GET', `${prefix}/pulls`],
    ['GET', `${prefix}/branches/main`], ['GET', `${prefix}/rules/branches/main`],
    ['GET', `${prefix}/actions/runs?head_sha=${head}`], ['GET', '/app/installations'],
    ['POST', '/app/installations/1/access_tokens'], ['GET', '/installation/repositories'],
  ]) assert.equal(githubApiVersion(method, endpoint), '2026-03-10');
});

test('foreign, malformed and ambiguous provenance paths cannot select the compatibility contract', () => {
  const prefix = '/repos/chwan886/GameDemo02';
  for (const endpoint of [
    '/repos/other/GameDemo02/pulls/1', '/repos/chwan886/Other/pulls/1', `${prefix}/pulls/0`, `${prefix}/pulls/01`,
    `${prefix}/pulls/1/`, `${prefix}/pulls/1\n`, `${prefix}/pulls/1?`, `${prefix}/pulls/1?page=0`,
    `${prefix}/pulls/1?page=1&page=2`, `${prefix}/pulls/1?per_page=101`, `${prefix}/pulls/1?unknown=1`, `${prefix}/pulls/1?page=1%0A`,
    `${prefix}/pulls/1?page=1?per_page=100`, `${prefix}/commits/${head}\n/pulls`,
    `${prefix}/commits/${head.toUpperCase()}/pulls`, `${prefix}/commits/main/pulls`,
    `https://api.github.com${prefix}/pulls/1`,
  ]) assert.equal(githubApiVersion('GET', endpoint), '2026-03-10', endpoint);
});
