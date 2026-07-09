/**
 * password.ts — a small, dependency-free password-strength estimator for the
 * Set-a-password screen (F3).
 *
 * The wallet vault is offline-attackable (the encrypted blob lives in
 * localStorage), so an 8-character low-entropy password is not enough. Rather
 * than impose arbitrary composition rules (which push people toward weak,
 * predictable patterns), we:
 *   - raise the hard minimum to 10 characters, and
 *   - give a live, plain-English strength read-out with a concrete next step,
 *   - and steer toward a longer passphrase (several words) — the single most
 *     effective thing a beginner can do.
 *
 * This is a heuristic, not a security guarantee. It is intentionally simple and
 * pure so it can be unit-tested and reasoned about.
 */

/** The hard minimum password length the UI enforces (F3: raised from 8). */
export const MIN_PASSWORD_LENGTH = 10;

/** A password strength band, weakest to strongest. */
export type PasswordStrength = 'too-short' | 'weak' | 'fair' | 'good' | 'strong';

/** The estimator's result: a band plus a plain-English hint and pass/fail. */
export interface PasswordAssessment {
  /** The strength band. */
  readonly strength: PasswordStrength;
  /** Whether the password clears the hard minimum bar to proceed. */
  readonly acceptable: boolean;
  /** A short, jargon-free hint telling the user where they stand / what to do. */
  readonly hint: string;
}

/**
 * A tiny list of the most common/guessable passwords and obvious keyboard
 * patterns. Not exhaustive — just enough to catch the worst offenders and nudge
 * the user. Compared case-insensitively.
 */
const COMMON_PASSWORDS: readonly string[] = [
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwertyuiop',
  'letmein',
  'iloveyou',
  'admin',
  'welcome',
  'monkey',
  'dragon',
  'abc123',
  'football',
  'bitcoin',
  'satoshi',
];

/** True if the password is (case-insensitively) a well-known guessable one. */
function isCommon(password: string): boolean {
  const lower = password.toLowerCase();
  return COMMON_PASSWORDS.includes(lower);
}

/** Counts the distinct character classes present (lower/upper/digit/symbol). */
function characterVariety(password: string): number {
  let variety = 0;
  if (/[a-z]/.test(password)) variety++;
  if (/[A-Z]/.test(password)) variety++;
  if (/[0-9]/.test(password)) variety++;
  if (/[^a-zA-Z0-9]/.test(password)) variety++;
  return variety;
}

/** True if the string looks like a passphrase (multiple space-separated words). */
function looksLikePassphrase(password: string): boolean {
  const words = password.trim().split(/\s+/).filter((w) => w.length >= 2);
  return words.length >= 3;
}

/**
 * Assesses a password's strength and returns a band + a beginner-friendly hint.
 * The `acceptable` flag gates the Set-password button (length ≥
 * {@link MIN_PASSWORD_LENGTH} and not a well-known common password).
 *
 * @param password - The candidate password (never logged or stored).
 * @returns The {@link PasswordAssessment}.
 */
export function assessPassword(password: string): PasswordAssessment {
  const length = password.length;

  if (length === 0) {
    return {
      strength: 'too-short',
      acceptable: false,
      hint: `Use at least ${MIN_PASSWORD_LENGTH} characters. A few words strung together is easiest to remember.`,
    };
  }

  if (length < MIN_PASSWORD_LENGTH) {
    return {
      strength: 'too-short',
      acceptable: false,
      hint: `A little longer, please — at least ${MIN_PASSWORD_LENGTH} characters. A few words together works well.`,
    };
  }

  // Meets the minimum length. A well-known password is still rejected.
  if (isCommon(password)) {
    return {
      strength: 'weak',
      acceptable: false,
      hint: 'That password is a common one attackers try first. Pick something only you would think of.',
    };
  }

  // A real passphrase (several words) is the gold standard we steer toward.
  if (looksLikePassphrase(password) && length >= 16) {
    return {
      strength: 'strong',
      acceptable: true,
      hint: 'Strong — a passphrase like this is easy to remember and hard to guess.',
    };
  }

  const variety = characterVariety(password);

  if (length >= 20 || (length >= 16 && variety >= 3)) {
    return {
      strength: 'strong',
      acceptable: true,
      hint: 'Strong. This is hard to guess — nice work.',
    };
  }

  if (length >= 14 || (length >= 12 && variety >= 3)) {
    return {
      strength: 'good',
      acceptable: true,
      hint: 'Good. Adding another word or two would make it even stronger.',
    };
  }

  if (length >= 12 || variety >= 3) {
    return {
      strength: 'fair',
      acceptable: true,
      hint: 'Okay — but longer is much safer. Try stringing a few words together.',
    };
  }

  // Meets the bare minimum length but is short and low-variety.
  return {
    strength: 'weak',
    acceptable: true,
    hint: 'This works, but it is on the weak side. A few words together would be much safer.',
  };
}
