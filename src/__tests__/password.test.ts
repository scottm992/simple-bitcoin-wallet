/**
 * password.test.ts — regression tests for the strengthened password policy (F3).
 * The old gate was a bare `length >= 8`. The new policy raises the minimum to 10
 * and rejects well-known common passwords, while steering toward passphrases.
 */
import { describe, it, expect } from 'vitest';
import { assessPassword, MIN_PASSWORD_LENGTH } from '../password';

describe('assessPassword (F3)', () => {
  it('rejects an 8-character password that the OLD policy accepted', () => {
    // The old code allowed any length >= 8; the new floor is 10.
    const a = assessPassword('pass1234'); // 8 chars
    expect(a.acceptable).toBe(false);
    expect(a.strength).toBe('too-short');
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(8);
  });

  it('rejects a well-known common password even at sufficient length', () => {
    const a = assessPassword('password123'); // 11 chars but notorious
    expect(a.acceptable).toBe(false);
    expect(a.strength).toBe('weak');
    expect(a.hint.toLowerCase()).toContain('common');
  });

  it('accepts a reasonable password at the new minimum length', () => {
    const a = assessPassword('correct-ten'); // 11 chars, mixed
    expect(a.acceptable).toBe(true);
  });

  it('rates a multi-word passphrase as strong', () => {
    const a = assessPassword('correct horse battery staple');
    expect(a.acceptable).toBe(true);
    expect(a.strength).toBe('strong');
  });

  it('gives a longer, higher band as length/variety grow', () => {
    const short = assessPassword('abcdefghij'); // 10, one class
    const longer = assessPassword('Abcdefghij12'); // 12, three classes
    const bands = ['too-short', 'weak', 'fair', 'good', 'strong'];
    expect(bands.indexOf(longer.strength)).toBeGreaterThan(bands.indexOf(short.strength));
  });

  it('always returns a plain-English hint (no empty guidance)', () => {
    for (const pw of ['', 'x', 'abcdefghij', 'correct horse battery staple']) {
      expect(assessPassword(pw).hint.length).toBeGreaterThan(0);
    }
  });
});
