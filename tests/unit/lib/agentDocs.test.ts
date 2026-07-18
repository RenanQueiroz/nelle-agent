import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'bun:test';

/**
 * The agent-docs structure is a contract, so it is pinned like one.
 *
 * The guidance is split across three directory-scoped `AGENTS.md` files because Claude Code
 * refuses a file over 150k characters — silently degrading the one mechanism that keeps agents
 * honest. The split only works while every `CLAUDE.md` stays a pure `@AGENTS.md` stub, and the
 * skills only work while `.claude/skills` keeps pointing at `.agents/skills` (the cross-agent
 * source of truth) and every `SKILL.md` carries frontmatter a discovery scan can read. None of
 * that is enforced by any tool at edit time, which is exactly the kind of drift a test catches.
 */

const AGENTS_FILES = ['AGENTS.md', 'apps/server/AGENTS.md', 'apps/client/AGENTS.md'];
const CLAUDE_STUBS = ['CLAUDE.md', 'apps/server/CLAUDE.md', 'apps/client/CLAUDE.md'];

// Claude Code's per-file limit. Crossing it does not error — the file is just dropped from
// context, which is how the original single AGENTS.md failed.
const CLAUDE_CODE_CHAR_LIMIT = 150_000;

const read = async (file: string) => (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');

test('every CLAUDE.md is a pure @AGENTS.md stub', async () => {
  for (const stub of CLAUDE_STUBS) {
    assert.equal((await read(stub)).trim(), '@AGENTS.md', `${stub} must contain only the import`);
  }
});

test('each AGENTS.md exists and stays under the 150k character limit', async () => {
  for (const file of AGENTS_FILES) {
    const text = await read(file);
    assert.ok(text.startsWith('# AGENTS'), `${file} lost its heading`);
    assert.ok(
      text.length < CLAUDE_CODE_CHAR_LIMIT,
      `${file} is ${text.length} chars — over Claude Code's ${CLAUDE_CODE_CHAR_LIMIT} limit, ` +
        'and it would be silently dropped from agent context. Split or trim it.',
    );
  }
});

test('.claude/skills points at .agents/skills, the cross-agent source of truth', async () => {
  const stat = await fs.lstat('.claude/skills');
  if (stat.isSymbolicLink()) {
    // `readlink` uses the host separator, so Windows returns `..\.agents\skills` for the same
    // target macOS and Linux spell `../.agents/skills`. Compare the paths, not their spelling.
    const target = await fs.readlink('.claude/skills');
    assert.equal(path.resolve('.claude', target), path.resolve('.agents/skills'));
  } else if (stat.isFile()) {
    // A Windows checkout without `core.symlinks` materializes the link as a plain file holding
    // the target path — still one source of truth, so it passes.
    assert.equal((await read('.claude/skills')).trim(), '../.agents/skills');
  } else {
    assert.fail('.claude/skills is a real directory — the skills have forked from .agents/skills');
  }
});

test('every skill has frontmatter a discovery scan can read', async () => {
  const entries = await fs.readdir('.agents/skills', {withFileTypes: true});
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(dirs.length > 0, 'no skills found under .agents/skills');

  for (const dir of dirs) {
    const text = await read(`.agents/skills/${dir}/SKILL.md`);
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    assert.ok(match, `${dir}/SKILL.md has no frontmatter block`);
    const [, frontmatter, body] = match;

    const name = frontmatter.match(/^name: (.+)$/m)?.[1]?.trim();
    const description = frontmatter.match(/^description: (.+)$/m)?.[1]?.trim();

    // agentskills.io constraints: lowercase alphanumerics and single hyphens, max 64 chars, and
    // the name must match its directory; the description is 1-1024 chars.
    assert.equal(name, dir, `${dir}/SKILL.md frontmatter name must match its directory`);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${dir}: invalid skill name`);
    assert.ok(name.length <= 64, `${dir}: name over 64 chars`);
    assert.ok(description, `${dir}: missing description`);
    assert.ok(description.length <= 1024, `${dir}: description over 1024 chars`);
    assert.ok(body.trim().length > 0, `${dir}: SKILL.md has no body`);
  }
});
