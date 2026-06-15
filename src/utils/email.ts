// src/utils/email.ts
// Shared lightweight email validation. Replaces the `/\S+@\S+\.\S+/` regex
// previously duplicated across the invoice/CO/issue send editors.

const EMAIL_RE = /\S+@\S+\.\S+/;

/** True when `s` (trimmed) looks like a single email address. */
export const isValidEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

/**
 * Split a comma/semicolon-separated list of addresses into trimmed entries,
 * dropping empties. Returns [] for blank/whitespace input.
 */
export const parseAddressList = (s: string): string[] =>
  s
    .split(/[,;]/)
    .map(a => a.trim())
    .filter(Boolean);

/**
 * True when every parsed address is valid. An empty list returns true
 * (suitable for optional cc/bcc fields). For required fields, also check
 * the list is non-empty.
 */
export const isValidAddressList = (s: string): boolean =>
  parseAddressList(s).every(isValidEmail);
