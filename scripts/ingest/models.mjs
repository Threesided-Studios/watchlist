// Supported defaults, checked against official deprecations on 2026-10-22.
// Recheck before future migrations; no model has guaranteed permanent availability.
export const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || 'gpt-6-luna';
/* The close read runs on the cheap model. Only when that read is unsure of itself is the
   screenshot read again by the strong model (about twenty times the price per token), so
   the strong model is paid for on the hard cases instead of on every screenshot. */
export const PARSE_MODEL = process.env.PARSE_MODEL || 'gpt-6-luna';
export const PARSE_STRONG_MODEL = process.env.PARSE_STRONG_MODEL || 'gpt-6-sol';
export const QA_MODEL = process.env.QA_MODEL || 'gpt-6-luna';
export const ART_VERIFY_MODEL = process.env.ART_VERIFY_MODEL || 'gpt-6-sol';
