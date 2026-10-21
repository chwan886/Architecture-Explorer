import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { TOOL_ROOT } from '../packages/indexer/src/config.ts';
import { createSmokeDirectory, removeSmokeDirectory } from '../Tools/ci-smoke-directories.ts';

const execute = promisify(execFile);
const invalidPem = 'INVALID-FIXTURE-NOT-A-PRIVATE-KEY\n';

// This script changes ACLs only on each freshly owned test directory/file.
// No real key path or key content is read by this suite.
const setFixtureAcl = String.raw`
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($env:AE_ACL_FIXTURE_TARGET)
$boundary=[IO.Path]::GetFullPath($env:AE_ACL_FIXTURE_ROOT).TrimEnd('\')+'\'
if(-not $target.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture ACL path escaped its owned root'}
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
$acl.SetOwner($current)
$item=Get-Item -LiteralPath $target -Force
foreach($sid in @($current.Value,'S-1-5-18','S-1-5-32-544')){
  $principal=[Security.Principal.SecurityIdentifier]::new($sid)
  if($item.PSIsContainer){
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  }else{
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','Allow')
  }
  $acl.AddAccessRule($rule)
}
if($env:AE_ACL_EXTRA_SID){
  $extra=[Security.Principal.SecurityIdentifier]::new($env:AE_ACL_EXTRA_SID)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($extra,'Read','Allow'))
}
Set-Acl -LiteralPath $target -AclObject $acl
`;

test('Windows App wrapper rejects unsafe keys before starting Node and accepts restricted inherited grants', async t => {
  assert.equal(process.platform, 'win32', 'The App key ACL entry point requires actual Windows ACL/link checks');
  const owned = await createSmokeDirectory(path.join(TOOL_ROOT, '.tmp'), TOOL_ROOT, 'app-auth-acl-test-');
  const fakeTool = path.join(owned.directory, 'fake-tool');
  const links: string[] = [];
  try {
    const lock = JSON.parse(await readFile(path.join(TOOL_ROOT, 'toolchain.lock.json'), 'utf8')) as { node: { version: string } };
    assert.match(lock.node.version, /^\d+\.\d+\.\d+$/);
    const nodeDirectory = path.join(fakeTool, '.tools', `node-v${lock.node.version}-win-x64`);
    const cliDirectory = path.join(fakeTool, 'node_modules', 'tsx', 'dist');
    await mkdir(path.join(fakeTool, 'Tools'), { recursive: true });
    await mkdir(nodeDirectory, { recursive: true });
    await mkdir(cliDirectory, { recursive: true });
    await copyFile(path.join(TOOL_ROOT, 'Tools', 'dev-app-auth.ps1'), path.join(fakeTool, 'Tools', 'dev-app-auth.ps1'));
    await writeFile(path.join(fakeTool, 'toolchain.lock.json'), JSON.stringify(lock));
    await copyFile(path.join(TOOL_ROOT, '.tools', `node-v${lock.node.version}-win-x64`, 'node.exe'), path.join(nodeDirectory, 'node.exe'));
    await writeFile(path.join(fakeTool, 'Tools', 'dev-app-auth.ts'), '// Fixture placeholder; never executes the real authentication implementation.\n');
    const sentinel = path.join(fakeTool, 'node-started.json');
    await writeFile(path.join(cliDirectory, 'cli.mjs'), `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
let input='';
for await (const chunk of process.stdin) input+=chunk;
writeFileSync(path.resolve(import.meta.dirname, '../../../node-started.json'), JSON.stringify({
  args:process.argv.slice(2), attestation:JSON.parse(input),
  inheritedToken:!!(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.GH_ENTERPRISE_TOKEN||process.env.GITHUB_ENTERPRISE_TOKEN),
  nodeOptions:process.env.NODE_OPTIONS??null, nodePath:process.env.NODE_PATH??null,
  nodeDebug:process.env.NODE_DEBUG??null, nativeDebug:process.env.NODE_DEBUG_NATIVE??null, ghDebug:process.env.GH_DEBUG??null
}));
console.log('Fixture Node started without reading any PEM or making a network request');
`);

    const fixtureAcl = async (target: string, extraSid = '') => {
      await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(setFixtureAcl, 'utf16le').toString('base64')], {
        env: { ...process.env, AE_ACL_FIXTURE_TARGET: target, AE_ACL_FIXTURE_ROOT: owned.directory, AE_ACL_EXTRA_SID: extraSid },
      });
    };
    const createKeyDirectory = async (name: string, withPem = true) => {
      const directory = path.join(owned.directory, name);
      await mkdir(directory);
      await fixtureAcl(directory);
      if (withPem) await writeFile(path.join(directory, 'fixture.pem'), invalidPem);
      return directory;
    };
    const run = async (args: string[]) => {
      try {
        const result = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(fakeTool, 'Tools', 'dev-app-auth.ps1'), ...args], {
          cwd: fakeTool,
          env: { ...process.env, GH_TOKEN: 'NONSECRET-FIXTURE-SENTINEL', GITHUB_TOKEN: 'NONSECRET-FIXTURE-SENTINEL', NODE_OPTIONS: '--invalid-fixture-option', NODE_PATH: 'NONSECRET-FIXTURE-SENTINEL', NODE_DEBUG: 'http', NODE_DEBUG_NATIVE: 'http', GH_DEBUG: 'api' },
        });
        return { code: 0, output: result.stdout + result.stderr };
      } catch (error) {
        const result = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof result.code !== 'number') throw error;
        return { code: result.code, output: (result.stdout ?? '') + (result.stderr ?? '') };
      }
    };
    const rejectBeforeNode = async (args: string[], reason: RegExp) => {
      const result = await run(args);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, reason);
      assert.doesNotMatch(result.output, /INVALID-FIXTURE-NOT-A-PRIVATE-KEY|S-1-5-|NONSECRET-FIXTURE-SENTINEL/);
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    };

    await t.test('requires explicit -Verify before touching even the default key directory', async () => {
      await rejectBeforeNode([], /VERIFY_REQUIRED/);
    });
    await t.test('rejects no PEM', async () => {
      const directory = await createKeyDirectory('empty', false);
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', directory], /EXACTLY_ONE_PEM_REQUIRED/);
    });
    await t.test('rejects multiple PEMs including case variants', async () => {
      const directory = await createKeyDirectory('multiple');
      await writeFile(path.join(directory, 'second.PEM'), invalidPem);
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', directory], /EXACTLY_ONE_PEM_REQUIRED/);
    });
    await t.test('rejects a key directory junction', async () => {
      const target = await createKeyDirectory('junction-target');
      const link = path.join(owned.directory, 'directory-junction');
      await symlink(target, link, 'junction'); links.push(link);
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', link], /LINK_REJECTED/);
    });
    await t.test('rejects a junction in a key directory ancestor', async () => {
      const target = path.join(owned.directory, 'ancestor-target');
      await mkdir(target);
      const nested = path.join(target, 'keys');
      await mkdir(nested); await fixtureAcl(nested);
      await writeFile(path.join(nested, 'fixture.pem'), invalidPem);
      const link = path.join(owned.directory, 'ancestor-junction');
      await symlink(target, link, 'junction'); links.push(link);
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', path.join(link, 'keys')], /LINK_REJECTED/);
    });
    await t.test('rejects a PEM file symbolic link', async () => {
      const directory = await createKeyDirectory('file-link', false);
      const target = path.join(owned.directory, 'unlinked-target.data');
      await writeFile(target, invalidPem);
      const link = path.join(directory, 'fixture.pem');
      await symlink(target, link, 'file'); links.push(link);
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', directory], /LINK_REJECTED/);
    });
    await t.test('rejects an additional directory Allow SID', async () => {
      const directory = await createKeyDirectory('directory-extra-grant');
      await fixtureAcl(directory, 'S-1-1-0');
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', directory], /ACL_GRANT_REJECTED/);
    });
    await t.test('rejects an additional PEM Allow SID', async () => {
      const directory = await createKeyDirectory('file-extra-grant');
      await fixtureAcl(path.join(directory, 'fixture.pem'), 'S-1-5-11');
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', directory], /ACL_GRANT_REJECTED/);
    });
    await t.test('rejects a receipt outside the tool root', async () => {
      const directory = await createKeyDirectory('receipt-escape');
      await rejectBeforeNode(['-Verify', '-PrivateKeyDirectory', directory, '-ReceiptPath', path.join(owned.directory, 'outside-tool.json')], /RECEIPT_OUTSIDE_TOOL/);
      await assert.rejects(access(path.join(owned.directory, 'outside-tool.json')), { code: 'ENOENT' });
    });
    await t.test('accepts only privileged inherited grants and passes non-secret metadata to locked Node', async () => {
      const directory = await createKeyDirectory('allowed-inheritance');
      const receipt = path.join(fakeTool, 'receipt.json');
      const result = await run(['-Verify', '-PrivateKeyDirectory', directory, '-ReceiptPath', receipt]);
      assert.equal(result.code, 0, result.output);
      const started = JSON.parse(await readFile(sentinel, 'utf8')) as {
        args: string[];
        attestation: { schemaVersion: number; keyFile: string; acl: { checked: boolean; inherited: boolean; linksRejected: boolean; owner: string; allowPrincipals: string[] }; fileIdentity: { size: number; mtimeMs: number } };
        inheritedToken: boolean; nodeOptions: string | null; nodePath: string | null;
        nodeDebug: string | null; nativeDebug: string | null; ghDebug: string | null;
      };
      assert.deepEqual(started.args, [path.join(fakeTool, 'Tools', 'dev-app-auth.ts'), '--key-file', path.join(directory, 'fixture.pem'), '--receipt', receipt]);
      assert.equal(started.attestation.schemaVersion, 1);
      assert.equal(started.attestation.keyFile, path.join(directory, 'fixture.pem'));
      assert.equal(started.attestation.acl.checked, true);
      assert.equal(started.attestation.acl.inherited, true);
      assert.equal(started.attestation.acl.linksRejected, true);
      assert.ok(['current-user', 'SYSTEM', 'Administrators'].includes(started.attestation.acl.owner));
      assert.deepEqual(started.attestation.acl.allowPrincipals, ['current-user', 'SYSTEM', 'Administrators']);
      assert.equal(started.attestation.fileIdentity.size, Buffer.byteLength(invalidPem));
      assert.ok(Number.isSafeInteger(started.attestation.fileIdentity.mtimeMs));
      assert.equal(started.inheritedToken, false);
      assert.equal(started.nodeOptions, null);
      assert.equal(started.nodePath, null);
      assert.equal(started.nodeDebug, null);
      assert.equal(started.nativeDebug, null);
      assert.equal(started.ghDebug, null);
      assert.equal(await readFile(path.join(directory, 'fixture.pem'), 'utf8'), invalidPem);
      assert.doesNotMatch(result.output, /INVALID-FIXTURE-NOT-A-PRIVATE-KEY|S-1-5-|NONSECRET-FIXTURE-SENTINEL/);
    });
  } finally {
    for (const link of links.reverse()) await unlink(link);
    await removeSmokeDirectory(owned);
  }
});
