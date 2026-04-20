/**
 * E2E scenario: search → navigate → fill form → submit → verify
 *
 * Prerequisites:
 *   cd bench/app && npm start   (Electron on port 19222)
 *
 * Run:
 *   cd D:/web-projects/agent-view
 *   npx tsx bench/scenarios/form-flow.ts
 */

import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(__dirname, '..', 'app')

// ── Types ─────────────────────────────────────────────────────────────────────

type StepResult = {
  name: string
  cmd: string
  pass: boolean
  output: string
  ms: number
  reason?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function av(cmd: string): { output: string; ms: number } {
  const t0 = Date.now()
  try {
    const output = execSync(`agent-view ${cmd}`, {
      cwd: APP_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { output: output.trim(), ms: Date.now() - t0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = (e.stdout ?? '') + (e.stderr ?? e.message ?? '')
    return { output: output.trim(), ms: Date.now() - t0 }
  }
}

function step(
  name: string,
  cmd: string,
  check: (out: string) => boolean,
  reason = 'output check failed',
): StepResult {
  process.stdout.write(`  ${name.padEnd(40, '.')} `)
  const { output, ms } = av(cmd)
  const pass = check(output)
  const label = pass ? 'PASS' : 'FAIL'
  console.log(`${label}  ${ms}ms`)
  return { name, cmd, pass, output, ms, reason: pass ? undefined : reason }
}

function contains(substr: string) {
  return (out: string) => out.toLowerCase().includes(substr.toLowerCase())
}

function notContains(substr: string) {
  return (out: string) => !out.toLowerCase().includes(substr.toLowerCase())
}

function noError(out: string): boolean {
  return !out.toLowerCase().includes('error') && !out.startsWith('Error')
}

// ── Scenario ──────────────────────────────────────────────────────────────────

console.log('\n=== form-flow scenario ===\n')
console.log('App dir:', APP_DIR)
console.log()

const results: StepResult[] = []

// Warmup: ensure server is running and app is reachable
console.log('  [warmup] connecting to app...')
const warmup = av('discover')
if (!warmup.output.includes('"id"')) {
  console.error('\nFAIL: bench app not running.')
  console.error('Start it with:  cd bench/app && npm start')
  process.exit(1)
}
console.log(`  [warmup] connected (${warmup.ms}ms)\n`)

// Reset form to clean state before running
av('click --filter "Reset"')

// Step 1 — Type "form" in the search box
results.push(step(
  '1. fill search "form"',
  'fill --filter "Search" "form"',
  noError,
  'fill command returned error',
))

// Step 2 — Verify search found exactly 1 section
results.push(step(
  '2. verify "1 section found" hint',
  'dom --filter "1 section found" --depth 1',
  contains('1 section found'),
  '"1 section found" not in DOM — search filter not working',
))

// Step 3 — Navigate to the Form section via nav link
results.push(step(
  '3. click "Form" nav link',
  'click --filter "Form"',
  noError,
  'click command returned error',
))

// Step 4 — Verify Name field is visible/accessible
results.push(step(
  '4. verify Name input visible',
  'dom --filter "Name" --depth 1',
  contains('Name'),
  '"Name" input not found in DOM',
))

// Step 5 — Fill Name field
results.push(step(
  '5. fill Name "Test User"',
  'fill --filter "Name" "Test User"',
  noError,
  'fill Name returned error',
))

// Step 6 — Fill Email field
results.push(step(
  '6. fill Email "test@example.com"',
  'fill --filter "Email" "test@example.com"',
  noError,
  'fill Email returned error',
))

// Step 7 — Select Option A radio
results.push(step(
  '7. click "Option A" radio',
  'click --filter "Option A"',
  noError,
  'click Option A returned error',
))

// Step 8 — Submit the form
results.push(step(
  '8. click Submit',
  'click --filter "Submit"',
  noError,
  'click Submit returned error',
))

// Step 9 — Verify success message appears
results.push(step(
  '9. verify success message',
  'dom --filter "Form submitted successfully" --depth 1',
  contains('Form submitted successfully'),
  '"Form submitted successfully" not in DOM — form did not submit',
))

// Step 10 — Verify no error summary visible (display:none → not in AX tree)
results.push(step(
  '10. verify no error summary',
  'dom --filter "Please fix" --depth 1',
  notContains('Please fix'),
  'Error summary is visible — validation failed unexpectedly',
))

// Step 11 — Verify individual field errors absent
results.push(step(
  '11. verify no field errors',
  'dom --filter "is required" --depth 1',
  notContains('is required'),
  'Field error messages visible — one or more fields invalid',
))

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.pass).length
const failed = results.filter(r => !r.pass).length
const totalMs = results.reduce((s, r) => s + r.ms, 0)

console.log()
console.log('─'.repeat(60))
console.log(`Results: ${passed} passed, ${failed} failed  (${totalMs}ms total)`)
console.log('─'.repeat(60))

if (failed > 0) {
  console.log('\nFailed steps:')
  results
    .filter(r => !r.pass)
    .forEach(r => {
      console.log(`\n  FAIL: ${r.name}`)
      console.log(`  cmd:    agent-view ${r.cmd}`)
      console.log(`  reason: ${r.reason}`)
      console.log(`  output: ${r.output.slice(0, 300)}`)
    })
  console.log()
  process.exit(1)
}

console.log('\nAll steps passed.\n')
