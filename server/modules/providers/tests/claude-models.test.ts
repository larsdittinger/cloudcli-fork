import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_PREDEFINED_MODELS,
  extractClaudeEventModel,
  findClaudeModelOption,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('offers every current-generation model under its exact id', () => {
  const values = new Set(CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value));
  for (const modelId of [
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-haiku-4-5',
  ]) {
    assert.ok(values.has(modelId), `${modelId} is missing from the Claude catalog`);
  }
});

test('pins each model to the effort levels it actually accepts', () => {
  const effortsOf = (modelId: string) =>
    findClaudeModelOption(modelId)?.effort?.values.map((value) => value.value) ?? [];

  // xhigh arrived with Opus 4.7, so the 4.6 generation must not offer it.
  assert.deepEqual(effortsOf('claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(effortsOf('claude-sonnet-4-6'), ['low', 'medium', 'high', 'max']);
  assert.ok(effortsOf('claude-opus-4-7').includes('xhigh'));
  assert.ok(effortsOf('claude-fable-5').includes('xhigh'));

  // Haiku rejects the effort parameter, so it carries no effort block at all.
  assert.equal(findClaudeModelOption('claude-haiku-4-5')?.effort, undefined);
});

test('keeps ultracode off pinned model ids', () => {
  for (const option of CLAUDE_PREDEFINED_MODELS.OPTIONS) {
    if (!option.value.startsWith('claude-')) {
      continue;
    }
    const efforts = option.effort?.values.map((value) => value.value) ?? [];
    assert.ok(!efforts.includes('ultracode'), `${option.value} must not offer ultracode`);
  }
});
