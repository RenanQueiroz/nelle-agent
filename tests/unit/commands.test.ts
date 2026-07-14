import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  COMPACT_COMMAND,
  isSupportedSlashCommand,
  parseCompactCommand,
  parseSlashCommandName,
  SLASH_COMMAND_REGISTRY,
  unsupportedSlashCommandMessage,
} from '../../apps/server/src/contracts/commands.ts';

test('only /compact is allowlisted today', () => {
  assert.deepEqual(
    SLASH_COMMAND_REGISTRY.commands.map(command => command.name),
    [COMPACT_COMMAND],
  );
  assert.equal(isSupportedSlashCommand('/compact'), true);
  assert.equal(isSupportedSlashCommand('/model'), false);
});

test('a command name is parsed case-insensitively, and only at the start', () => {
  assert.equal(parseSlashCommandName('/Compact do it'), '/compact');
  assert.equal(parseSlashCommandName('  /model  '), '/model');
  assert.equal(parseSlashCommandName('what does /model do?'), null);
  assert.equal(parseSlashCommandName('hello'), null);
});

test('an ordinary prompt is never mistaken for a command', () => {
  assert.equal(unsupportedSlashCommandMessage('summarise the /etc/hosts file'), null);
  assert.equal(unsupportedSlashCommandMessage('/compact keep the last answer'), null);
});

test('a known Pi command is refused with the Nelle control that replaces it', () => {
  assert.equal(
    unsupportedSlashCommandMessage('/model gemma'),
    '/model is handled by Nelle UI. Use the model selector in the composer or assistant footer.',
  );
});

test('an unknown command names the commands that do work', () => {
  assert.equal(
    unsupportedSlashCommandMessage('/nonsense'),
    '/nonsense is not supported in Nelle chat. Supported commands: /compact.',
  );
});

test('allowlisting a command server-side needs no client change', () => {
  // The client passes the registry it fetched. A server that starts allowing
  // /summarise stops the client refusing it, with no new client release.
  const registry = {
    commands: [
      ...SLASH_COMMAND_REGISTRY.commands,
      {name: '/summarise', description: 'Summarise this conversation'},
    ],
    unsupported: SLASH_COMMAND_REGISTRY.unsupported,
  };
  assert.equal(unsupportedSlashCommandMessage('/summarise', registry), null);
  // And it still refuses what the server still refuses.
  assert.match(unsupportedSlashCommandMessage('/model', registry) ?? '', /model selector/);
});

test('/compact instructions are parsed, and nothing else is', () => {
  assert.equal(parseCompactCommand('/compact'), '');
  assert.equal(parseCompactCommand('/compact  keep the plan  '), 'keep the plan');
  assert.equal(parseCompactCommand('/compacted'), null);
  assert.equal(parseCompactCommand('compact'), null);
  assert.equal(parseCompactCommand('tell me about /compact'), null);
});
