// Fixture: intentionally invalid TypeScript source.
//
// Verifies Req 4.1: a file with a syntax error is SKIPPED (not parsed into
// defs/calls/apiCalls), the skip is recorded as a warning, and analysis of all
// other files continues. This file is never imported by other fixtures.
//
// NOTE: This file is intentionally broken. It lives under tests/fixtures/ which
// is OUTSIDE the tsconfig `include` (src/**/*.ts), so it never participates in
// the project's tsc build (prevents the regression seen in task 1.3).

export function brokenComposable( {
  const url = '/api/broken
  return axios.get(url
}
