import { describe, expect, it } from 'vitest';

import { parseLines, ruleOpenAutonomyError } from '@/modules/settings/tabs/channels-settings/ruleValidation';

describe('ruleOpenAutonomyError', () => {
  it('refuses bypass or auto-reply without a sender filter', () => {
    expect(ruleOpenAutonomyError({ conditions: {}, permissionMode: 'bypassPermissions', replyMode: 'none' })).toMatch(/sender filter/);
    expect(ruleOpenAutonomyError({ conditions: { senders: ['*'] }, permissionMode: 'default', replyMode: 'auto' })).toMatch(/sender filter/);
    expect(ruleOpenAutonomyError({ conditions: { senders: [' '] }, permissionMode: 'acceptEdits', replyMode: 'draft' })).toMatch(/sender filter/);
  });

  it('allows the default mode with drafts, and autonomy for listed senders', () => {
    expect(ruleOpenAutonomyError({ conditions: {}, permissionMode: 'default', replyMode: 'draft' })).toBeNull();
    expect(ruleOpenAutonomyError({ conditions: { senders: ['jan@firma.cz'] }, permissionMode: 'bypassPermissions', replyMode: 'auto' })).toBeNull();
  });
});

describe('parseLines', () => {
  it('splits on newlines and commas and trims', () => {
    expect(parseLines(' a@b.cz\n@firma.cz, +420*\n\n')).toEqual(['a@b.cz', '@firma.cz', '+420*']);
  });
});
