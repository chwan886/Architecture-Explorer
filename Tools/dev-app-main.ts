import { createHash } from 'node:crypto';
import type { AuthRequest, Repository } from './dev-app-auth.ts';

type Json = Record<string, any>;
const tool = 'chwan886/Architecture-Explorer', game = 'chwan886/GameDemo02';
const sha = (value: unknown): value is string => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const states = ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'];
const conclusions = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'];
const status = (value: unknown) => typeof value === 'string' && states.includes(value) ? value : 'unrecognized';
const conclusion = (value: unknown) => value === null ? null : typeof value === 'string' && conclusions.includes(value) ? value : 'unrecognized';

/** Read fixed resources using the existing single-repository App session. This never dispatches or changes configuration. */
export async function inspectRepositoryMain(options: { repository: Repository; prNumber: number }, mainSha: string, token: string, request: AuthRequest) {
  if (![tool, game].includes(options.repository) || !id(options.prNumber) || !sha(mainSha)) throw Error('MAIN_INSPECTION_ARGUMENT_INVALID');
  const repository = options.repository, prefix = `/repos/${repository}`, blockers: string[] = [];
  const safeLabel = (value: unknown): value is string => label(value) && !value.includes(token);
  const report: Json = { repository, mainSha, inspectedRef: 'refs/heads/main', inspectionOnly: true,
    sourceTupleControllerConfirmed: false, blockers, productionReady: false };
  const get = async (endpoint: string) => {
    try { const value = await request('GET', endpoint, token); return value.status === 200 ? value.data : undefined; }
    catch { return undefined; } // Raw HTTP errors and payloads may contain credentials.
  };
  const meta = await get(prefix);
  if (meta?.full_name !== repository || meta?.html_url !== `https://github.com/${repository}` || !id(meta?.id) ||
    meta?.default_branch !== 'main' || meta?.private !== true) throw Error('MAIN_REPOSITORY_IDENTITY_OR_VISIBILITY_MISMATCH');
  report.repositoryMetadata = { id: meta.id, defaultBranch: 'main', private: true, archived: meta.archived === true };
  if (meta.archived === true) blockers.push('REPOSITORY_ARCHIVED');
  const branch = await get(`${prefix}/branches/main`);
  report.branch = { protected: typeof branch?.protected === 'boolean' ? branch.protected : null, frozenShaMatches: branch?.commit?.sha === mainSha };
  if (branch?.commit?.sha !== mainSha) blockers.push('MAIN_BRANCH_UNREADABLE_OR_CHANGED_DURING_INSPECTION');
  if (branch?.protected !== true) blockers.push('MAIN_PROTECTION_NOT_CONFIRMED');
  const pr = await get(`${prefix}/pulls/${options.prNumber}`);
  report.prObservation = { state: ['open', 'closed'].includes(pr?.state) ? pr.state : 'unrecognized',
    numberMatches: pr?.number === options.prNumber, merged: pr?.merged === true, validMergeTimestamp: typeof pr?.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)),
    urlMatches: pr?.html_url === `https://github.com/${repository}/pull/${options.prNumber}`, mergeShaValid: sha(pr?.merge_commit_sha), headShaValid: sha(pr?.head?.sha), authorIdValid: id(pr?.user?.id),
    mergeShaShape: pr?.merge_commit_sha === null ? 'null' : typeof pr?.merge_commit_sha,
    ...(typeof pr?.merge_commit_sha === 'string' ? { mergeShaLength: pr.merge_commit_sha.length } : {}),
    baseMatches: pr?.base?.ref === 'main' && pr?.base?.repo?.full_name === repository, headRepositoryMatches: pr?.head?.repo?.full_name === repository,
    appBotMatches: pr?.user?.login === 'chwan-dev-agent[bot]' && pr?.user?.type === 'Bot' };
  if (pr?.number === options.prNumber && pr?.html_url === `https://github.com/${repository}/pull/${options.prNumber}` && pr.state === 'closed' && pr.merged === true &&
    typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)) && sha(pr.merge_commit_sha) && sha(pr.head?.sha) &&
    pr.base?.ref === 'main' && pr.base?.repo?.full_name === repository && pr.head?.repo?.full_name === repository &&
    pr.user?.login === 'chwan-dev-agent[bot]' && pr.user?.type === 'Bot' && id(pr.user?.id)) {
    const bot = await get('/users/chwan-dev-agent%5Bbot%5D');
    const compare = await get(`${prefix}/compare/${pr.merge_commit_sha}...${mainSha}`);
    const inMain = compare?.base_commit?.sha === pr.merge_commit_sha && ['identical', 'ahead'].includes(compare?.status);
    report.mergedPr = { number: pr.number, url: pr.html_url, mergedAt: new Date(pr.merged_at).toISOString(), mergeSha: pr.merge_commit_sha, headSha: pr.head.sha,
      author: { login: pr.user.login, id: pr.user.id, type: 'Bot' }, appAuthorVerified: bot?.id === pr.user.id && bot?.login === pr.user.login && bot?.type === 'Bot', mergeInMainHistory: inMain };
    // Equal Git trees bind controller-provided files from the reviewed head to this exact main.
    // Never infer this from similar versions, commit messages or the merge strategy.
    const mainCommit = await get(`${prefix}/git/commits/${mainSha}`), headCommit = await get(`${prefix}/git/commits/${pr.head.sha}`);
    if (mainCommit?.sha === mainSha && headCommit?.sha === pr.head.sha && sha(mainCommit.tree?.sha) && sha(headCommit.tree?.sha)) {
      report.mergedPr.mainTreeSha = mainCommit.tree.sha; report.mergedPr.headTreeSha = headCommit.tree.sha;
      report.mergedPr.headTreeMatchesMain = mainCommit.tree.sha === headCommit.tree.sha;
    } else { report.mergedPr.headTreeMatchesMain = null; blockers.push('MERGED_PR_TREE_RELATION_UNREADABLE'); }
    if (!report.mergedPr.appAuthorVerified) blockers.push('MERGED_PR_APP_AUTHOR_UNCONFIRMED');
    if (!inMain) blockers.push('MERGED_PR_NOT_PROVEN_IN_FROZEN_MAIN');
  } else blockers.push('MERGED_PR_IDENTITY_OR_STATE_UNCONFIRMED');

  const rules = await get(`${prefix}/rules/branches/main`);
  if (Array.isArray(rules)) {
    const reviews = rules.filter(rule => rule?.type === 'pull_request').map(rule => rule.parameters ?? {});
    const contexts = rules.filter(rule => rule?.type === 'required_status_checks').flatMap(rule => rule.parameters?.required_status_checks ?? [])
      .map(check => check?.context).filter(safeLabel);
    report.effectiveRules = { readable: true, ruleCount: rules.length,
      approvingReviewCount: reviews.reduce((max, rule) => Math.max(max, Number.isSafeInteger(rule.required_approving_review_count) ? rule.required_approving_review_count : 0), 0),
      codeOwner: reviews.some(rule => rule.require_code_owner_review === true),
      dismissStale: reviews.some(rule => rule.dismiss_stale_reviews_on_push === true),
      lastPushApproval: reviews.some(rule => rule.require_last_push_approval === true),
      conversationResolution: reviews.some(rule => rule.required_review_thread_resolution === true),
      strictChecks: rules.some(rule => rule?.type === 'required_status_checks' && rule.parameters?.strict_required_status_checks_policy === true),
      requiredCheckContexts: [...new Set(contexts)], bypassReview: 'not-proven-by-effective-rule-response' };
    if (!reviews.length || report.effectiveRules.approvingReviewCount < 1 || !report.effectiveRules.codeOwner) blockers.push('EFFECTIVE_RULESET_REVIEW_GATES_INCOMPLETE');
    if (repository === tool && !contexts.includes('Tool / typecheck, tests and builds')) blockers.push('TOOL_REQUIRED_CHECK_NOT_OBSERVED');
  } else { report.effectiveRules = { readable: false }; blockers.push('EFFECTIVE_RULES_UNREADABLE'); }

  const paths = repository === tool ? ['.github/workflows/tool-ci.yml', '.github/workflows/game-index.yml', '.github/CODEOWNERS']
    : ['.github/workflows/architecture.yml', 'Tools/explorer-dispatch-contract.json', 'ProjectSettings/ProjectVersion.txt'];
  report.files = [];
  for (const file of paths) {
    const value = await get(`${prefix}/contents/${file}?ref=${mainSha}`);
    try {
      if (value?.type !== 'file' || value.path !== file || !sha(value.sha) || value.encoding !== 'base64' ||
        typeof value.content !== 'string' || value.content.length > 1_500_000 || !/^[A-Za-z0-9+/=\s]*$/.test(value.content)) throw Error();
      const encoded = value.content.replace(/\s/g, ''), bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length > 1_048_576 || value.size !== bytes.length) throw Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const evidence: Json = { path: file, gitBlobSha: value.sha, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, sourceSha: mainSha };
      if (file.endsWith('ProjectVersion.txt')) {
        const version = /^m_EditorVersion:\s*([A-Za-z0-9._-]{1,80})\s*$/m.exec(text)?.[1];
        if (!version || version.includes(token)) throw Error(); evidence.editorVersion = version; report.editorVersion = version;
      }
      if (file.endsWith('explorer-dispatch-contract.json')) {
        const contract = JSON.parse(text);
        evidence.receiverReady = typeof contract.receiver_ready === 'boolean' ? contract.receiver_ready : null;
        evidence.receiverCommit = sha(contract.receiver_commit) ? contract.receiver_commit : null;
        evidence.receiverValidationRunUrl = typeof contract.receiver_validation_run_url === 'string' && !/[\x00-\x20\x7f]/.test(contract.receiver_validation_run_url) && /^https:\/\/github\.com\/chwan886\/Architecture-Explorer\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*)?$/.test(contract.receiver_validation_run_url)
          ? contract.receiver_validation_run_url : null;
      }
      report.files.push(evidence);
    } catch { report.files.push({ path: file, readable: false, sourceSha: mainSha }); blockers.push(`REQUIRED_FILE_UNREADABLE:${file}`); }
  }

  const workflows = repository === tool ? ['tool-ci.yml', 'game-index.yml'] : ['architecture.yml'];
  report.workflows = [];
  for (const file of workflows) {
    const value = await get(`${prefix}/actions/workflows/${file}`);
    if (id(value?.id) && value.path === `.github/workflows/${file}` && value.state === 'active') report.workflows.push({ id: value.id, path: value.path, state: 'active' });
    else { report.workflows.push({ path: `.github/workflows/${file}`, activeVerified: false }); blockers.push(`WORKFLOW_NOT_ACTIVE_OR_UNREADABLE:${file}`); }
  }
  const runs: Json[] = [];
  let runsReadable = true;
  for (let page = 1; page <= 10; page++) {
    const value = await get(`${prefix}/actions/runs?event=push&branch=main&head_sha=${mainSha}&per_page=100&page=${page}`);
    if (!Array.isArray(value?.workflow_runs) || value.workflow_runs.length > 100) { runsReadable = false; break; }
    runs.push(...value.workflow_runs);
    if (value.workflow_runs.length < 100) break;
    if (page === 10) runsReadable = false;
  }
  report.mainPushRuns = [];
  for (const run of runs.filter(run => run?.event === 'push' && run.head_branch === 'main' && run.head_sha === mainSha && workflows.some(file => run.path === `.github/workflows/${file}`))) {
    if (!id(run.id) || !id(run.run_attempt) || run.html_url !== `https://github.com/${repository}/actions/runs/${run.id}`) { runsReadable = false; continue; }
    const jobs: Json[] = []; let jobsReadable = true;
    for (let page = 1; page <= 10; page++) {
      const value = await get(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
      if (!Array.isArray(value?.jobs) || value.jobs.length > 100) { jobsReadable = false; break; }
      for (const job of value.jobs) {
        if (!id(job?.id) || !safeLabel(job?.name) || job.run_id !== run.id || job.head_sha !== mainSha || job.run_attempt !== run.run_attempt) { jobsReadable = false; continue; }
        const steps: Json[] = [];
        if (Array.isArray(job.steps)) for (const step of job.steps) {
          if (!id(step?.number) || !safeLabel(step?.name)) { jobsReadable = false; continue; }
          steps.push({ number: step.number, name: step.name, status: status(step.status), conclusion: conclusion(step.conclusion) });
        }
        jobs.push({ id: job.id, runId: job.run_id, headSha: job.head_sha, attempt: job.run_attempt, name: job.name, status: status(job.status), conclusion: conclusion(job.conclusion), steps,
          url: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}` });
      }
      if (value.jobs.length < 100) break;
      if (page === 10) jobsReadable = false;
    }
    const artifacts: Json[] = []; let artifactsReadable = true;
    for (let page = 1; page <= 10; page++) {
      const value = await get(`${prefix}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
      if (!Array.isArray(value?.artifacts) || value.artifacts.length > 100) { artifactsReadable = false; break; }
      for (const artifact of value.artifacts) {
        if (!id(artifact?.id) || !safeLabel(artifact?.name) || !Number.isSafeInteger(artifact?.size_in_bytes) || artifact.size_in_bytes < 0 || typeof artifact.expired !== 'boolean' ||
          (artifact.workflow_run && (artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== mainSha))) { artifactsReadable = false; continue; }
        artifacts.push({ id: artifact.id, name: artifact.name, sizeBytes: artifact.size_in_bytes, expired: artifact.expired,
          url: `https://github.com/${repository}/actions/runs/${run.id}/artifacts/${artifact.id}` });
      }
      if (value.artifacts.length < 100) break;
      if (page === 10) artifactsReadable = false;
    }
    report.mainPushRuns.push({ id: run.id, url: run.html_url, path: run.path, attempt: run.run_attempt, headSha: mainSha,
      status: status(run.status), conclusion: conclusion(run.conclusion), jobsReadable, jobs, artifactsReadable, artifacts });
    if (!jobsReadable) blockers.push('MAIN_RUN_JOBS_UNREADABLE');
    if (!artifactsReadable) blockers.push('MAIN_RUN_ARTIFACTS_UNREADABLE');
  }
  if (!runsReadable) blockers.push('MAIN_PUSH_RUNS_UNREADABLE_OR_LIMITED');
  const ciPath = repository === tool ? '.github/workflows/tool-ci.yml' : '.github/workflows/architecture.yml';
  const ci = report.mainPushRuns.filter((run: Json) => run.path === ciPath);
  const requiredJobName = repository === tool ? 'Tool / typecheck, tests and builds' : 'fast-gate';
  const completedJobsPass = (run: Json) => run.jobsReadable && run.jobs.length > 0 &&
    run.jobs.some((job: Json) => job.name === requiredJobName && job.status === 'completed' && job.conclusion === 'success') &&
    run.jobs.every((job: Json) => job.status === 'completed' && (job.conclusion === 'success' ||
      (repository === game && job.name === 'dispatch-explorer' && job.conclusion === 'skipped')));
  report.mainCi = !runsReadable || !ci.length ? 'not-proven' : ci.some((run: Json) => run.status !== 'completed') ? 'in-progress'
    : ci.every((run: Json) => run.conclusion === 'success' && completedJobsPass(run)) ? 'success' : 'failure';
  if (report.mainCi !== 'success') blockers.push('FROZEN_MAIN_CI_NOT_SUCCESSFUL');
  report.manualPrerequisites = ['Environment/main-only rules', 'Production read App and secret names', 'Artifact audience and bypass review', 'Unity reference supply', 'Controller-confirmed exact source tuple'];
  return report;
}
