// One command for the whole release: build, package, smoke-test the packaged
// exe for a startup crash, and only then publish to GitHub Releases. Cleans up
// after electron-builder's occasional split-draft-release quirk (it has, at
// least once, uploaded the installer and its .blockmap to two separate draft
// releases sharing the same tag instead of one) before going live.
//
// Usage:  node scripts/release.mjs
// Requires: `gh auth login` already done (this reads `gh auth token` itself —
// you never need to type a token or set GH_TOKEN by hand).
//
// Bump "version" in package.json BEFORE running this — it refuses to publish
// over a tag that already exists, since re-publishing an existing version's
// tag is how the split-release problem started last time.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const { owner, repo } = pkg.build.publish[0];
const productName = pkg.build.productName;

function header(name) {
  console.log(`\n\x1b[1m=== ${name} ===\x1b[0m`);
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
}

function ghJson(cmd) {
  return JSON.parse(execSync(cmd, { cwd: root, encoding: 'utf8' }));
}

function fail(message) {
  console.error(`\n\x1b[31mRELEASE ABORTED:\x1b[0m ${message}`);
  process.exit(1);
}

// ── 0. Sanity checks before doing anything expensive ─────────────────────
header('Checking prerequisites');
try {
  execSync('gh auth status', { cwd: root, stdio: 'pipe' });
} catch {
  fail('gh is not logged in. Run `gh auth login` first.');
}

const existing = ghJson(`gh api repos/${owner}/${repo}/releases --paginate`);
if (existing.some((r) => r.tag_name === tag)) {
  fail(
    `A release for ${tag} already exists on github.com/${owner}/${repo}. ` +
      `Bump "version" in package.json before running this again — publishing ` +
      `over an existing tag is exactly how the last release ended up split ` +
      `across two drafts.`
  );
}

// ── 1. Clear anything that could lock files mid-build ────────────────────
header('Closing any running Forge instances');
spawnSync('powershell', [
  '-NoProfile',
  '-Command',
  'Get-Process Forge,electron -ErrorAction SilentlyContinue | Stop-Process -Force',
]);

// ── 2. Build + package locally, no publish yet ───────────────────────────
header('Building');
run('npm run build');

header('Packaging (no publish yet)');
run('npx electron-builder --win --publish never');

// ── 3. Smoke-test: launch the packaged exe and check for (a) a main-process
// crash dialog and (b) the renderer having actually painted real UI — not
// just "didn't crash". A silent blank-window failure (e.g. index.html's
// asset paths not resolving under file://) shows neither a dialog nor a
// process exit, so absence of a crash dialog alone is not enough.
header('Smoke-testing the packaged build');
const exe = path.join(root, 'release', 'win-unpacked', `${productName}.exe`);
if (!fs.existsSync(exe)) fail(`Packaged exe not found at ${exe}`);

const smokeTestScript = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -PassThru
Start-Sleep -Seconds 6
Add-Type -AssemblyName UIAutomationClient
$rootEl = [System.Windows.Automation.AutomationElement]::RootElement

$errCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Error')
$errWin = $rootEl.FindFirst([System.Windows.Automation.TreeScope]::Children, $errCond)
$crashed = $errWin -ne $null

$stillRunning = -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue).HasExited

# The renderer having actually painted is checked by looking for the "Chat"
# tab label every real window shows (from App.tsx's view switcher) — a blank
# unrendered window has no text content at all, crash dialog or not.
$rendered = $false
if ($stillRunning -and -not $crashed) {
  $appWin = Get-Process -Id $p.Id | ForEach-Object { $_.MainWindowHandle } | Where-Object { $_ -ne 0 }
  if ($appWin) {
    $winEl = [System.Windows.Automation.AutomationElement]::FromHandle($appWin)
    $textCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Chat')
    $chatEl = $winEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $textCond)
    $rendered = $chatEl -ne $null
  }
}

Stop-Process -Id $p.Id -Force
Get-Process ${productName} -ErrorAction SilentlyContinue | Stop-Process -Force

if ($crashed) { Write-Output 'SMOKE_TEST_CRASHED' }
elseif (-not $stillRunning) { Write-Output 'SMOKE_TEST_EXITED' }
elseif (-not $rendered) { Write-Output 'SMOKE_TEST_BLANK' }
else { Write-Output 'SMOKE_TEST_OK' }
`;
const smoke = spawnSync('powershell', ['-NoProfile', '-Command', smokeTestScript], { encoding: 'utf8' });
const smokeResult = (smoke.stdout || '').trim();
if (!smokeResult.includes('SMOKE_TEST_OK')) {
  const reason = smokeResult.includes('SMOKE_TEST_CRASHED')
    ? 'a main-process crash dialog appeared'
    : smokeResult.includes('SMOKE_TEST_EXITED')
      ? 'the process exited on its own'
      : smokeResult.includes('SMOKE_TEST_BLANK')
        ? 'the window opened but never rendered the app (blank window — no "Chat" tab found)'
        : `unexpected smoke-test output: ${smokeResult || '(none)'}`;
  fail(`The packaged build failed its smoke test: ${reason}.\nNothing was published. Run "release\\win-unpacked\\${productName}.exe" by hand to see it.`);
}
console.log('Packaged build launched cleanly and rendered real UI.');

// ── 4. Publish ────────────────────────────────────────────────────────────
header(`Publishing ${tag} to github.com/${owner}/${repo}`);
const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
run('npx electron-builder --win --publish always', { env: { ...process.env, GH_TOKEN: token } });

// ── 5. electron-builder has, at least once, split a multi-asset publish
// across two draft releases sharing the same tag (installer+yml on one,
// the .blockmap alone on the other). If that happened again, merge them —
// using the local files we just built rather than trusting either draft.
header('Verifying every asset landed on one release');
const releases = ghJson(`gh api repos/${owner}/${repo}/releases`).filter((r) => r.tag_name === tag);
if (releases.length === 0) fail(`electron-builder reported success but no release for ${tag} exists — check the log above.`);

if (releases.length > 1) {
  console.log(`Found ${releases.length} draft releases tagged ${tag} — merging into one.`);
  // `gh release upload <tag>` resolves by tag alone — with two releases still
  // sharing this tag, it silently picks whichever the API happens to return
  // first, which can be the one about to get deleted. Delete every duplicate
  // FIRST so the tag is unambiguous, THEN upload whatever's missing.
  releases.sort((a, b) => b.assets.length - a.assets.length);
  const [primary, ...dupes] = releases;

  for (const dupe of dupes) {
    run(`gh api -X DELETE repos/${owner}/${repo}/releases/${dupe.id}`);
    console.log(`Deleted duplicate draft release ${dupe.id}.`);
  }

  const expected = {
    [`${productName}-Setup-${version}.exe`]: path.join(root, 'release', `${productName} Setup ${version}.exe`),
    [`${productName}-Setup-${version}.exe.blockmap`]: path.join(
      root,
      'release',
      `${productName} Setup ${version}.exe.blockmap`
    ),
    'latest.yml': path.join(root, 'release', 'latest.yml'),
  };

  for (const [remoteName, localPath] of Object.entries(expected)) {
    if (primary.assets.some((a) => a.name === remoteName)) continue;
    if (!fs.existsSync(localPath)) fail(`Missing local file for ${remoteName}: ${localPath}`);
    // gh sanitizes spaces in the uploaded filename, so upload from a
    // dash-named copy to keep the remote name exactly what latest.yml expects.
    const dashedCopy = path.join(root, 'release', remoteName);
    fs.copyFileSync(localPath, dashedCopy);
    run(`gh release upload ${tag} "${dashedCopy}" --repo ${owner}/${repo} --clobber`);
    console.log(`Uploaded missing asset ${remoteName}.`);
  }
} else {
  const names = releases[0].assets.map((a) => a.name).sort();
  const wantNames = [`${productName}-Setup-${version}.exe`, `${productName}-Setup-${version}.exe.blockmap`, 'latest.yml'].sort();
  if (JSON.stringify(names) !== JSON.stringify(wantNames)) {
    fail(`Release ${tag} exists but its asset list looks wrong: ${names.join(', ')}. Check it by hand before publishing.`);
  }
  console.log('All three expected assets are present on one release.');
}

// ── 6. Go live ────────────────────────────────────────────────────────────
header(`Publishing release ${tag} (removing draft status)`);
run(`gh release edit ${tag} --repo ${owner}/${repo} --draft=false`);

console.log(`\n\x1b[32mDone.\x1b[0m https://github.com/${owner}/${repo}/releases/tag/${tag}`);
