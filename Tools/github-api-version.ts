/** PR merge provenance still uses merge_commit_sha, removed from REST 2026-03-10.
 * Pin only its two read resources to the supported 2022-11-28 contract.
 * https://docs.github.com/en/rest/about-the-rest-api/breaking-changes
 */
export function githubApiVersion(method: string, endpoint: string): '2022-11-28' | '2026-03-10' {
  const current = '2026-03-10';
  if (method !== 'GET' || /[\x00-\x20\x7f]/.test(endpoint)) return current;
  const parts = endpoint.split('?');
  if (parts.length > 2) return current;
  const [pathname, query] = parts;
  if (!/^\/repos\/chwan886\/(?:Architecture-Explorer|GameDemo02)\/(?:pulls\/[1-9]\d*|commits\/[a-f0-9]{40}\/pulls)$/.test(pathname)) return current;
  if (query !== undefined) {
    const seen = new Set<string>();
    const parameters = new URLSearchParams(query);
    if (!query || ![...parameters].length) return current;
    for (const [name, value] of parameters) {
      if (seen.has(name) || !['page', 'per_page'].includes(name) || /[\x00-\x20\x7f]/.test(value) || !/^[1-9]\d{0,19}$/.test(value)) return current;
      if (name === 'per_page' && Number(value) > 100) return current;
      seen.add(name);
    }
  }
  return '2022-11-28';
}
