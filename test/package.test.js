import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT } from '../lib/runtime.mjs';

function installedPiPackage() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      let current = path.dirname(realpathSync(path.join(directory, 'pi')));
      for (let depth = 0; depth < 6; depth++) {
        candidates.push(current, path.join(current, 'libexec/lib/node_modules/@earendil-works/pi-coding-agent'));
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8'));
      if (['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(metadata.name) &&
          existsSync(path.join(candidate, 'dist/core/extensions/loader.js'))) return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return null;
}


const sdk = installedPiPackage();
const paperthinSource = JSON.parse(readFileSync(path.join(ROOT, 'vendor/paperthin/source.json'), 'utf8'));
const skillCatalog = JSON.parse(readFileSync(path.join(ROOT, 'config/skills.json'), 'utf8'));

test('the complete skill catalog preserves upstream content and invocation boundaries', () => {
  assert.equal(paperthinSource.skills.length, 28);
  assert.equal(new Set(paperthinSource.skills).size, 28);
  assert.deepEqual(skillCatalog.map((skill) => skill.name), paperthinSource.skills);
  assert.equal(skillCatalog.filter((skill) => skill.invocation === 'user').length, 12);
  assert.equal(skillCatalog.filter((skill) => skill.invocation === 'model').length, 16);
  for (const skill of skillCatalog) {
    const relativePath = `skills/${skill.name}/SKILL.md`;
    const contents = readFileSync(path.join(ROOT, 'vendor/paperthin', relativePath), 'utf8');
    assert.equal(createHash('sha256').update(contents).digest('hex'), paperthinSource.sha256[relativePath]);
    const frontmatter = contents.split('---', 3)[1];
    assert.equal(/^disable-model-invocation: true$/m.test(frontmatter), skill.invocation === 'user');
    assert.ok(skill.when.length > 0);
    assert.ok(skill.roles.length > 0);
    assert.ok(['check', 'edit', 'loop', 'maintenance'].includes(skill.kind));
    assert.ok(['depth', 'breadth', 'coil', 'mesh'].includes(skill.category));
  }
});

test('Pi package loads from an unrelated project with isolated settings', {
  skip: sdk ? false : 'Installed Pi SDK unavailable.',
}, async (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'paperthin-package '));
  const cwd = path.join(base, 'unrelated-project');
  const agentDir = path.join(base, 'isolated-agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { DefaultResourceLoader } = await import(pathToFileURL(path.join(sdk, 'dist/core/resource-loader.js')).href);
  const { SettingsManager } = await import(pathToFileURL(path.join(sdk, 'dist/core/settings-manager.js')).href);
  const extensionPath = path.join(ROOT, 'extensions/workflow.ts');
  for (const scenario of [
    { name: 'global package with untrusted unrelated project', options: {}, skillCount: paperthinSource.skills.length },
    { name: 'explicit extension path deduplicates package discovery', options: { additionalExtensionPaths: [extensionPath] }, skillCount: paperthinSource.skills.length },
    { name: 'noSkills suppresses manifest skills', options: { noSkills: true }, skillCount: 0 },
  ]) {
    await t.test(scenario.name, async () => {
      const settingsManager = SettingsManager.inMemory({ packages: [ROOT] }, { projectTrusted: false });
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
        ...scenario.options,
      });
      await loader.reload();
      const extensions = loader.getExtensions();
      assert.deepEqual(extensions.errors, []);
      assert.equal(extensions.extensions.length, 1);
      assert.equal(realpathSync(extensions.extensions[0].resolvedPath), realpathSync(extensionPath));
      assert.ok(extensions.extensions[0].commands.has('lead'));
      const loaded = loader.getSkills();
      assert.deepEqual(loaded.diagnostics, []);
      // Pi may also discover shared user skills outside agentDir. Check the
      // package's exact contribution without changing HOME or user settings.
      const packageRoot = realpathSync(path.join(ROOT, 'vendor/paperthin/skills')) + path.sep;
      const packageSkills = loaded.skills.filter((skill) => realpathSync(skill.filePath).startsWith(packageRoot));
      assert.equal(packageSkills.length, scenario.skillCount);
      if (scenario.options.noSkills) assert.equal(loaded.skills.length, 0);
      if (scenario.skillCount) {
        assert.deepEqual(packageSkills.map((skill) => skill.name).sort(), [...paperthinSource.skills].sort());
      }
      assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    });
  }
});
