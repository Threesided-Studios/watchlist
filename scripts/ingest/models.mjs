// Supported defaults, checked against official deprecations on 2026-10-22.
// Recheck before future migrations; no model has guaranteed permanent availability.
export const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || 'gpt-6-luna';
/* v2: the closer read is done by the stronger model; triage stays on the cheap one. */
export const PARSE_MODEL = process.env.PARSE_MODEL || 'gpt-6-sol';
export const QA_MODEL = process.env.QA_MODEL || 'gpt-6-luna';
export const ART_VERIFY_MODEL = process.env.ART_VERIFY_MODEL || 'gpt-6-sol';
