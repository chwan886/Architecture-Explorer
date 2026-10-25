import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, mkdir, rm, link, symlink, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertUnlinkedPath, parseAppArguments, readBoundedFile } from '../Tools/dev-app-cli.ts';

const execute=promisify(execFile), root=path.resolve(import.meta.dirname,'..');
const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const environment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:GH_|GITHUB_|NODE_|TSX_|GIT_)/i.test(key)));
async function powershell(script:string, extraEnv:Record<string,string>={}) {
  const {stdout}=await execute(process.env.EXPLORER_POWERSHELL??'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    env:{...environment(),...extraEnv},windowsHide:true,maxBuffer:1024*1024,
  });
  return stdout.trim();
}

test('App CLI accepts only explicit operations and exact per-operation arguments',()=>{
  const common=['--config-file','C:/ignored/config.local.json','--key-file','C:/outside/app.pem','--operation'];
  assert.equal(parseAppArguments([...common,'verify']).operation,'verify');
  for (const args of [
    [...common,'approve'],[...common,'merge'],[...common,'verify','--token','personal'],
    [...common,'verify','--branch','main'],[...common,'push'],[...common,'verify','--config-file','other'],
    [...common,'status','--expected-head','a'.repeat(40),'--pr-number','-1'],
  ]) assert.throws(()=>parseAppArguments(args));
});

test('bounded App input rejects links, hardlinks, empty or oversized files before parsing',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'app-cli-input-'));
  t.after(async()=>{assert.ok(directory.startsWith(path.join(os.tmpdir(),'app-cli-input-')));await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'public.json');await writeFile(file,'{}');
  // Hosted Windows runners expose an 8.3 temp alias. Both spellings must
  // identify the same ordinary file while linked paths below still fail.
  const canonical=await realpath(file);
  assert.equal(await assertUnlinkedPath(file),canonical);
  assert.equal((await readBoundedFile(file,4)).toString(),'{}');
  assert.equal((await readBoundedFile(canonical,4)).toString(),'{}');
  await assert.rejects(readBoundedFile(file,1));
  const hard=path.join(directory,'hard.json');await link(file,hard);
  await assert.rejects(readBoundedFile(hard,4));
  const target=path.join(directory,'target');await mkdir(target);await writeFile(path.join(target,'file.json'),'{}');
  const alias=path.join(directory,'alias');await symlink(target,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(readBoundedFile(path.join(alias,'file.json'),4));
  const empty=path.join(directory,'empty.json');await writeFile(empty,'');await assert.rejects(readBoundedFile(empty,4));
});

test('Windows key preflight checks both ACLs, uniqueness and linked parents without reading PEM contents',async t=>{
  assert.equal(process.platform,'win32','This regression belongs to Windows integration CI');
  const directory=await mkdtemp(path.join(os.tmpdir(),'app-key-preflight-'));
  t.after(async()=>{assert.ok(directory.startsWith(path.join(os.tmpdir(),'app-key-preflight-')));await rm(directory,{recursive:true,force:true});});
  const script=`
    $ErrorActionPreference='Stop'
    . ${quote(path.join(root,'Tools/dev-app-key.ps1'))}
    $directory=${quote(directory)}
    $keyDirectory=Join-Path $directory 'keys'
    New-Item -ItemType Directory -Path $keyDirectory | Out-Null
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $keyDirectory -AclObject $acl
    $keyFile=Join-Path $keyDirectory 'app.pem'
    [IO.File]::WriteAllText($keyFile,'opaque-test-key-never-read')
    $proof=Get-AppKeyAttestation $keyDirectory ${quote(root)}
    if ($proof.acl.checked -ne $true -or $proof.fileIdentity.size -ne 26) {throw 'Bad preflight proof'}
    $results=@('restricted-pass')
    $configFile=Join-Path $directory 'app.local.json'
    @{schemaVersion=1;appId=123;installationId=456;appSlug='fixture-app';repository='fixture-owner/fixture-repo';baseBranch='main';keyDirectory=$keyDirectory} | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
    $pwsh=(Get-Process -Id $PID).Path
    $wrapperOutput=& $pwsh -NoProfile -File ${quote(path.join(root,'Tools/dev-app-auth.ps1'))} -ConfigFile $configFile -Push -WorkingDirectory $directory -Branch codex/fixture -ExpectedHead ('a'*40) -NodeExecutable ${quote(process.execPath)} 2>&1 | Out-String
    if ($LASTEXITCODE -ne 1 -or $wrapperOutput -notmatch 'failed during git-preflight;' -or $wrapperOutput -match 'opaque-test-key-never-read') {throw 'Push argument framing failed'}
    $results+=@('push-arguments-forwarded')
    [IO.File]::WriteAllText((Join-Path $keyDirectory 'second.pem'),'opaque')
    try {Get-AppKeyAttestation $keyDirectory ${quote(root)} | Out-Null;throw 'accepted extra PEM'} catch {if ($_.Exception.Message -notmatch 'EXACTLY_ONE_PEM_REQUIRED') {throw}}
    Remove-Item -LiteralPath (Join-Path $keyDirectory 'second.pem')
    $results+=@('multiple-rejected')
    $alias=Join-Path $directory 'alias'
    New-Item -ItemType Junction -Path $alias -Value $keyDirectory | Out-Null
    try {Get-AppKeyAttestation $alias ${quote(root)} | Out-Null;throw 'accepted link'} catch {if ($_.Exception.Message -notmatch 'LINK_REJECTED') {throw}}
    $results+=@('link-rejected')
    [IO.File]::WriteAllText((Join-Path $directory '.git'),'gitdir: metadata-placeholder')
    try {Get-AppKeyAttestation $keyDirectory ${quote(root)} | Out-Null;throw 'accepted repository key'} catch {if ($_.Exception.Message -notmatch 'KEY_MUST_BE_OUTSIDE_REPOSITORY') {throw}}
    Remove-Item -LiteralPath (Join-Path $directory '.git')
    $results+=@('repository-key-rejected')
    $fileAcl=Get-Acl -LiteralPath $keyFile
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
    Set-Acl -LiteralPath $keyFile -AclObject $fileAcl
    try {Get-AppKeyAttestation $keyDirectory ${quote(root)} | Out-Null;throw 'accepted broad file ACL'} catch {if ($_.Exception.Message -notmatch 'ACL_GRANT_REJECTED') {throw}}
    $results+=@('file-acl-rejected')
    $fileAcl.RemoveAccessRuleAll([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
    Set-Acl -LiteralPath $keyFile -AclObject $fileAcl
    $directoryAcl=Get-Acl -LiteralPath $keyDirectory
    $directoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'))
    Set-Acl -LiteralPath $keyDirectory -AclObject $directoryAcl
    try {Get-AppKeyAttestation $keyDirectory ${quote(root)} | Out-Null;throw 'accepted broad directory ACL'} catch {if ($_.Exception.Message -notmatch 'ACL_GRANT_REJECTED') {throw}}
    $results+=@('directory-acl-rejected')
    $results | ConvertTo-Json -Compress
  `;
  assert.deepEqual(JSON.parse(await powershell(script)),['restricted-pass','push-arguments-forwarded','multiple-rejected','link-rejected','repository-key-rejected','file-acl-rejected','directory-acl-rejected']);
});

test('App wrapper stops on missing key without invoking personal environment credentials or revealing them',async()=>{
  const sentinel='personal-fixture-never-use-or-log';
  const script=`
    $ErrorActionPreference='Stop'
    $temp=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.json')
    try {
      @{keyDirectory='C:/missing-app-key-fixture'} | ConvertTo-Json | Set-Content -LiteralPath $temp
      & ${quote(path.join(root,'Tools/dev-app-auth.ps1'))} -ConfigFile $temp -Verify
      exit $LASTEXITCODE
    } finally {Remove-Item -LiteralPath $temp -Force}
  `;
  await assert.rejects(powershell(script,{GITHUB_TOKEN:sentinel,GH_TOKEN:sentinel}),error=>{
    const value=error as {stdout?:string;stderr?:string};
    const output=String(value.stdout)+String(value.stderr);
    assert.ok(!output.includes(sentinel));
    assert.match(output,/App preflight rejected: PATH_UNREADABLE/);
    return true;
  });
});
