#!/usr/bin/env node
// Test-quality checks for agent-written PRs. Copy to .github/scripts/test-quality.mjs; no dependencies.
//
//   guard       block test tampering: deleted or skipped tests, a lower test count, `.only`,
//               loosened assertions, and test-runner ignore settings (agents do this to get a pass).
//               Edits to this checker or the workflows are blocked too, except a workflow edit that
//               only pins actions to commits or lowers permissions (vulnwatch's security fixes).
//   fail-first  a new or changed test file must FAIL when the PR's code under test is put back to
//               the base version (tests, helpers and configs stay as the PR has them); a test that
//               passes on both checks nothing (SWE-bench's fail-to-pass rule). A PR that adds tests
//               for unchanged code needs a "Test changes:" line.
//   mutation    plant small bugs in the PR's changed source and require the tests to catch
//               MUTATION_MIN percent (default 50; not 100, since some planted bugs change nothing).
//               --all mutates everything, for the weekly report. TEST_CMD runs the whole suite;
//               MUTATION_INCLUDE (regex) limits it to the paths the unit tests cover.
//   report      weekly: slowest tests (JUnit XML) and tests that catch no planted bug (Stryker
//               JSON), posted as one GitHub issue for a cleanup PR.
//
// A PR line `Test changes: <reason>` lets guard and fail-first pass, with the reason printed for
// the reviewer (refactors with characterization tests, a test removed on purpose).
// Env: BASE_REF (PR base branch), TEST_FILE_CMD (runs given test files, `{files}` is replaced;
// detected when unset), GITHUB_EVENT_PATH / GITHUB_REPOSITORY / GITHUB_TOKEN from Actions.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TEST_FILE = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const TEST_CONFIG = /(^|\/)(vitest|jest|playwright|karma)\.config\.[cm]?[jt]s$|(^|\/)(pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml|conftest\.py)$/;
const TEST_DECL = /(?<![.\w$])(?:it|test)(?:\.(?:each|concurrent|failing|only)[^(]*)?\s*\(|\.(?:it|test)\s*\(\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*,|^\s*(?:async\s+)?def\s+test_|\bfunc\s+Test[A-Z_]/gm;
const SKIP = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bpytest\.skip\(|\bt\.skip\(|\{\s*skip\s*:\s*true|\bt\.Skip\(/;
const ONLY = /\b(?:it|test|describe)\.only\s*\(|\bfdescribe\s*\(|\bfit\s*\(/;
const IGNORE = /ignore|exclude|testPathIgnorePatterns|testMatch|deselect|--skip|collect_ignore/i;
const ASSERT = /\bexpect\s*\(|\bassert\b|\bassert\.|\bt\.(?:equal|deepEqual|ok|is)\b|\bself\.(?:assert\w*|fail)\s*\(/;  // Lanes: unittest's self.assert*
const WEAK = /\.toBeTruthy\(\)|\.toBeDefined\(\)|\.not\.toBeNull\(\)|expect\.anything\(\)|\.toBeGreaterThanOrEqual\(0\)|>=\s*0\b|\bassert\s+True\b|assert\.ok\(\s*true\s*\)|\bassert\s+\w+\s+is\s+not\s+None\s*$|\bself\.assertTrue\(\s*True\s*\)/;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const git = (...args) => sh("git", args);

function base() {
  const ref = process.env.BASE_REF;
  if (!ref) throw new Error("BASE_REF is not set (the PR's base branch)");
  return git("merge-base", `origin/${ref}`, "HEAD").trim();
}

function prBody() {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request?.body || "";
  } catch {
    return "";
  }
}

function exemption() {
  // Only text a reader sees counts: HTML comments and code blocks are dropped first.
  const visible = prBody().replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
  const match = visible.match(/^[ \t>*_-]*Test changes:[ \t]*(\S.*)$/im);
  return match ? match[1].trim() : "";
}

function finish(name, problems) {
  if (!problems.length) {
    console.log(`${name}: ok`);
    return 0;
  }
  const reason = exemption();
  for (const p of problems) console.log(`${reason ? "::warning::" : "::error::"}${name}: ${p}`);
  if (reason) {
    console.log(`${name}: allowed by the PR's "Test changes:" line: ${reason}`);
    return 0;
  }
  console.log(`${name}: blocked. Fix the tests, or add a line "Test changes: <why>" to the PR description; the reviewer reads it.`);
  return 1;
}

function show(rev, path) {
  try {
    return git("show", `${rev}:${path}`);
  } catch {
    return "";
  }
}

const count = (text) => (text.match(TEST_DECL) || []).length;

const CI_FILE = /^\.github\/(scripts\/test-quality\.mjs$|workflows\/)/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const USES = /^(\s*(?:-\s+)?uses:\s+)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s@#]+)?)@([^\s#]+)(?:\s+(#.*))?$/;
const SCOPE = /^(\s*)([a-z-]+):\s+(none|read|write)(?:\s+(#.*))?$/;
const ALL = /^(\s*permissions:\s+)(write-all|read-all|\{\s*\})(?:\s+(#.*))?$/;
const RANK = { write: 2, "write-all": 2, read: 1, "read-all": 1, none: 0 };
const SCOPES = new Set(["actions", "artifact-metadata", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues", "models", "packages", "pages", "pull-requests", "repository-projects", "security-events", "statuses"]);
// Quotes could open or close a multiline string around the line; other breaks split lines for YAML but not here.
const UNSAFE = /["'\\\v\f\x1c-\x1e\x85\u2028\u2029]|\r(?!$)/;

export function workflowEditProblem(oldText, newText, pins = []) {
  // null when every changed line only hardens the workflow, else why not. Hardening is a `uses:`
  // ref moved from a tag or branch to a full commit sha (same action; the comment may become the
  // old tag, as in `@<sha> # v4`), or a lower `permissions:` level (write > read > none). Lines are
  // compared in place, so a step added, removed or moved fails. Each pin is pushed to `pins` as
  // {action, ref, sha}: the caller must still confirm the sha is in the ref's own history.
  const was = oldText.split("\n");
  const now = newText.split("\n");
  if (was.length !== now.length) return "lines were added or removed";
  const scripts = new Set([...scriptLines(was), ...quotedLines(was), ...scriptLines(now), ...quotedLines(now)]);
  for (let i = 0; i < now.length; i++) {
    if (was[i] === now[i]) continue;
    const where = `line ${i + 1}: ${now[i].trim().slice(0, 100)}`;
    if (scripts.has(i) || UNSAFE.test(was[i]) || UNSAFE.test(now[i])) return `not a plain workflow line, ${where}`;
    const pin = usesKey(was, i) && usesKey(now, i) && pinsAction(strip(was[i]), strip(now[i]));
    if (pin) pins.push(pin);
    else if (!(lowered(strip(was[i]), strip(now[i])) && lowersPermission(was, i) && lowersPermission(now, i))) {
      return `only pinning an action to a commit or lowering a permission can pass, ${where}`;
    }
  }
  return null;
}

function pinsAction(before, after) {
  const a = before.match(USES);
  const b = after.match(USES);
  if (!a || !b || a[1] !== b[1] || a[2] !== b[2] || /^[0-9a-f]{40}$/.test(a[3]) || !/^[0-9a-f]{40}$/.test(b[3])) return false;
  // The comment is inert; keep it, drop it, or name the replaced ref with one plain token.
  const comment = b[4] === a[4] || b[4] === undefined || /^#\s*[\w.+/-]+$/.test(b[4]);
  return comment && { action: a[2].split("/").slice(0, 2).join("/"), ref: a[3], sha: b[3] };
}

function usesKey(lines, i) {
  // `uses:` must be a step's key (`- uses:`, or under a `- name:` item in `steps:`) or a job's
  // (a reusable workflow), not an env var or action input named `uses`.
  const up = parent(lines, i);
  if (up < 0) return false;
  const isSteps = (j) => j >= 0 && /^\s*steps:\s*(?:#.*)?$/.test(strip(lines[j]));
  if (/^\s*-\s/.test(lines[i])) return isSteps(owner(lines, i));
  if (/^\s*-\s/.test(lines[up])) return isSteps(owner(lines, up));
  const jobs = parent(lines, up);
  return jobs >= 0 && /^jobs:\s*(?:#.*)?$/.test(strip(lines[jobs]));
}

function lowered(before, after) {
  const a = before.match(SCOPE) || before.match(ALL);
  const b = after.match(SCOPE) || after.match(ALL);
  if (!a || !b || a[1] !== b[1]) return false;
  if (before.match(ALL)) return Boolean(after.match(ALL)) && (RANK[b[2]] ?? 0) < RANK[a[2]];
  return !after.match(ALL) && a[2] === b[2] && SCOPES.has(a[2]) && RANK[b[3]] < RANK[a[3]];
}

function lowersPermission(lines, i) {
  // The line must be a real `permissions:` key, or a scope under one: the workflow's or a job's
  // (an action input named `permissions` under `with:` is not one).
  let key = i;
  if (!ALL.test(strip(lines[i]))) {
    key = parent(lines, i);
    if (key < 0 || !/^\s*permissions:\s*(?:#.*)?$/.test(strip(lines[key]))) return false;
  }
  if (indent(lines[key]) === 0) return true;
  const job = parent(lines, key);
  const jobs = job < 0 ? -1 : parent(lines, job);
  return jobs >= 0 && /^jobs:\s*(?:#.*)?$/.test(strip(lines[jobs]));
}

const strip = (line) => line.replace(/\r$/, "");
const indent = (line) => line.length - line.trimStart().length;

function parent(lines, i) {
  // Nearest line above with less indentation, skipping blanks and comments.
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].trim() || lines[j].trim().startsWith("#")) continue;
    if (indent(lines[j]) < indent(lines[i])) return j;
  }
  return -1;
}

function owner(lines, i) {
  // The key a `- ` item belongs to. YAML lets the dash sit at the key's own indentation
  // (`steps:` then `- uses:` in the same column), so a same-column line that is not another item counts.
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].trim() || lines[j].trim().startsWith("#")) continue;
    if (indent(lines[j]) < indent(lines[i]) || (indent(lines[j]) === indent(lines[i]) && !/^\s*-(?:\s|$)/.test(lines[j]))) return j;
  }
  return -1;
}

function quotedLines(lines) {
  // Lines inside a quoted string that spans lines (`run: "echo a` ... `b"`). YAML folds them into one
  // value, so their text is not workflow keys, and a `#` added there would comment out the rest.
  const out = new Set();
  const scripts = scriptLines(lines);
  const close = (line, from, q) => {
    for (let k = from; k < line.length; k++) {
      if (q === '"' && line[k] === "\\") k++;
      else if (line[k] === q && q === "'" && line[k + 1] === "'") k++;
      else if (line[k] === q) return k;
    }
    return -1;
  };
  let open = null;
  lines.forEach((line, i) => {
    if (scripts.has(i)) return;
    let k = 0;
    if (open) {
      out.add(i);
      k = close(line, 0, open);
      if (k < 0) return;
      open = null;
      k++;
    }
    for (; k < line.length; k++) {
      if (line[k] === "#" && (k === 0 || /\s/.test(line[k - 1]))) break;
      // A quote opens a string only where a value starts: after `key: `, `- `, `[`, `{` or `,`,
      // and any anchor or tag (`&script`, `!!str`).
      if ((line[k] === '"' || line[k] === "'") && /(?:^|[:,[{]|(?:^|\s)-)\s*(?:[&!]\S*\s+)*$/.test(line.slice(0, k))) {
        const end = close(line, k + 1, line[k]);
        if (end < 0) {
          open = line[k];
          break;
        }
        k = end;
      }
    }
  });
  return out;
}

function scriptLines(lines) {
  // Lines inside block scalars (`run: |` and the like): text there is a script, not workflow keys.
  const out = new Set();
  let over = null;
  lines.forEach((line, i) => {
    if (over !== null && (!line.trim() || indent(line) > over)) return out.add(i);
    over = /[:-]\s+(?:[&!]\S*\s+)*[|>][+-]?\d?[+-]?\s*(?:#.*)?\r?$/.test(line) ? indent(line.replace(/^(\s*)(?:-\s+)+/, (m, s) => s + " ".repeat(m.length - s.length))) : null;
  });
  return out;
}

export function guardDiff(entries, read, pins = []) {
  // entries: [{status, path, oldPath}]; read(side, path) -> file text. Pure, so it is unit-tested.
  // Action pins it lets through are pushed to `pins` for pinProblems to confirm upstream.
  const problems = [];
  let before = 0;
  let after = 0;
  for (const { status, path, oldPath } of entries) {
    if (CI_FILE.test(path) || CI_FILE.test(oldPath || "")) {
      // A workflow edit passes only when every changed line hardens CI (see workflowEditProblem).
      const why = status !== "M" || !WORKFLOW_FILE.test(path) ? "" : workflowEditProblem(read("base", path), read("head", path), pins);
      if (why !== null) problems.push(`${path}: changes the CI checks themselves${why ? ` (${why})` : ""}`);
    }
    const isTest = TEST_FILE.test(path) || (oldPath && TEST_FILE.test(oldPath));
    if (TEST_CONFIG.test(path) && status !== "D") {
      const added = addedLines(read("base", oldPath || path), read("head", path));
      for (const line of added) if (IGNORE.test(line)) problems.push(`${path}: test-runner setting added: ${line.trim()}`);
    }
    if (!isTest) continue;
    const old = status === "A" ? "" : read("base", oldPath || path);
    const now = status === "D" ? "" : read("head", path);
    before += count(old);
    after += count(now);
    if (status === "D") {
      if (count(old)) problems.push(`${path}: test file deleted (${count(old)} tests)`);
      continue;
    }
    const added = addedLines(old, now);
    const removed = addedLines(now, old);
    for (const line of added) {
      if (SKIP.test(line)) problems.push(`${path}: test skipped: ${line.trim()}`);
      if (ONLY.test(line)) problems.push(`${path}: .only runs one test and silently skips the rest: ${line.trim()}`);
    }
    const weak = added.filter((line) => WEAK.test(line));
    if (weak.length && removed.some((line) => ASSERT.test(line) && !WEAK.test(line))) {
      problems.push(`${path}: a check was replaced by a weaker one: ${weak[0].trim()}`);
    }
    if (count(now) < count(old)) problems.push(`${path}: ${count(old) - count(now)} fewer tests`);
    // Any assertion that is gone or rewritten needs a reason, even if others were added elsewhere.
    const inAssertion = assertionLines(old);
    const dropped = removed.filter((line) => inAssertion.has(line) && !/^\s*(\/\/|#|\*)/.test(line));
    if (dropped.length) problems.push(`${path}: ${dropped.length} assertion(s) removed or changed, e.g. ${dropped[0].trim()}`);
  }
  if (after < before) problems.push(`the PR lowers the test count from ${before} to ${after}`);
  return problems;
}

export function assertionLines(text) {
  // Every line of every assertion statement, so a changed value on a later line of a multiline
  // assertion counts as a changed assertion.
  const out = new Set();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!ASSERT.test(lines[i])) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      out.add(lines[j]);
      for (const ch of lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) depth += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
      // The statement ends when its brackets close, unless the next line continues a matcher
      // chain (.toBe...) or a Python line ends with a backslash.
      if (depth <= 0 && !/^\s*\./.test(lines[j + 1] || "") && !/\\\s*$/.test(lines[j])) break;
    }
  }
  return out;
}

function addedLines(oldText, newText) {
  // Lines of newText that are not in oldText (a multiset difference; enough for these checks).
  const pool = new Map();
  for (const line of oldText.split("\n")) pool.set(line, (pool.get(line) || 0) + 1);
  const out = [];
  for (const line of newText.split("\n")) {
    const left = pool.get(line) || 0;
    if (left) pool.set(line, left - 1);
    else if (line.trim()) out.push(line);
  }
  return out;
}

function changedEntries(from) {
  // -z: paths exactly as git stores them, never quoted or escaped.
  const parts = git("diff", "-z", "--name-status", "-M", `${from}...HEAD`).split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (code.startsWith("R") || code.startsWith("C")) out.push({ status: code[0], oldPath: parts[i++], path: parts[i++] });
    else out.push({ status: code[0], path: parts[i++] });
  }
  return out;
}

export async function pinProblems(pins, compare) {
  // A pinned sha must be the commit its old ref names, or an older one in that ref's history, on the
  // action's own repo; any other commit (a fork's, say) runs code the ref never had.
  // compare(action, base, head) -> GitHub's compare status ("identical", "ahead", ...) or throws.
  const problems = [];
  const seen = new Set();
  for (const { action, ref, sha } of pins) {
    const key = `${action}@${ref}>${sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let status;
    try {
      status = await compare(action, sha, ref);
    } catch (error) {
      problems.push(`${action}@${sha}: could not confirm it is in ${ref}'s history (${error.message})`);
      continue;
    }
    if (status !== "identical" && status !== "ahead") problems.push(`${action}@${sha}: not in ${ref}'s history on ${action} (${status})`);
  }
  return problems;
}

async function githubCompare(action, from, to) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "test-quality" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/${action}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}?per_page=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub said ${response.status}`);
  return (await response.json()).status;
}

async function guard() {
  const from = base();
  const entries = changedEntries(from);
  const pins = [];
  const problems = guardDiff(entries, (side, path) => show(side === "base" ? from : "HEAD", path), pins);
  return finish("test guard", [...problems, ...(await pinProblems(pins, githubCompare))]);
}

function detectTestCommand(root) {
  if (process.env.TEST_FILE_CMD) return process.env.TEST_FILE_CMD;
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return "npx vitest run {files}";
  if (deps.jest) return "npx jest {files}";
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) return "python3 -m pytest -q {files}";
  return "node --test {files}";
}

function linkDependencies(from, to, depth = 0) {
  // The base checkout reuses the PR checkout's installed packages instead of installing again.
  if (depth > 3) return;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.name === "node_modules" || entry.name === ".venv") {
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target);
      }
    } else if (existsSync(target)) {
      linkDependencies(source, target, depth + 1);
    }
  }
}

// Code under test: source files outside test areas. Everything else a PR changes (tests, helpers,
// fixtures, conftest.py, configs, packages) is test setup and stays as the PR has it.
// Lanes: server/lanes is a Python program with no extension.
const CODE_UNDER_TEST = /\.([cm]?[jt]sx?|py|go|rb|rs|java|kt|swift)$|^server\/lanes$/;
const MISSING = [
  /No module named '([\w.]+)'/g,
  /cannot import name '\w+' from '([\w.]+)'/g,
  /Cannot find module '([^'\n]+)'/g,
  /ERR_MODULE_NOT_FOUND[^\n]*?'([^'\n]+)'/g,
  /requested module '([^'\n]+)' does not provide an export/g,
];
// Evidence that a test body ran and failed. Suite, hook and load failures come first and count
// as setup, since they also print FAIL or not ok without running a test.
const FAILED = /AssertionError|AssertError|\bExpected\b|failureType: 'testCodeFailure'|^E\s+assert\b|\b\d+ failed\b/m;
const SETUP_ERROR = /fixture '[^'\n]+' not found|IndentationError|errors? during collection|ERR_REQUIRE_ESM|Cannot use import statement|Test suite failed to run|failureType: '(?:hookFailed|suiteFailure|cancelledByParent)'|\b(?:before|after)(?:Each|All)?\b[^\n]*hook|hook failed|Failed to load|\b[1-9]\d* errors?\b/i;

const stem = (ref) => ref.replace(/\.[cm]?[jt]sx?$|\.py$/, "").split(/[/.]/).filter(Boolean).pop() || "";

export function importedModules(text) {
  // Module names from real import statements only (multiline ESM, require, dynamic import, Python).
  const patterns = [
    /\bimport\s+(?:type\s+)?[\w*${}\s,]*?\s*from\s*["']([^"'\n]+)["']/g,
    /\bimport\s*["']([^"'\n]+)["']/g,
    /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /^\s*from\s+([\w.]+)\s+import\b/gm,
    /^\s*import\s+([\w.]+)/gm,
  ];
  return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
}

export function judgeOldRun(status, output, testText, code) {
  // "fails": the test failed because of the old code under test. "passes": it checks nothing.
  // "setup": it could not run for another reason, which proves nothing.
  if (status === 0) return "passes";
  if (status === null || status === 126 || status === 127) return "setup";
  const refs = MISSING.flatMap((re) => [...output.matchAll(re)].map((m) => m[1]));
  if (refs.length) {
    // A missing module or export counts only when it is code under test that the test file
    // itself imports; a helper that conftest.py or a setup file needs is setup.
    const codeStems = new Set(code.map((e) => stem(e.path)));
    const imported = new Set(importedModules(testText).map(stem));
    return refs.every((ref) => codeStems.has(stem(ref)) && imported.has(stem(ref))) ? "fails" : "setup";
  }
  if (SETUP_ERROR.test(output)) return "setup";
  return FAILED.test(output) ? "fails" : "setup";
}

export function codeUnderTest(entries) {
  return entries.filter((e) => CODE_UNDER_TEST.test(e.path) && !TEST_FILE.test(e.path) && !TEST_CONFIG.test(e.path)
    && !/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(e.path) && !(e.oldPath && TEST_FILE.test(e.oldPath)));
}

function failFirst() {
  // Runs the PR's new and changed tests on the PR with only its code under test put back to the
  // base version, so a test fails there because of the code it tests and nothing else.
  const from = base();
  const entries = changedEntries(from);
  const tests = entries
    .filter((e) => e.status !== "D" && TEST_FILE.test(e.path) && /\.([cm]?[jt]sx?|py|go)$/.test(e.path))
    .map((e) => e.path)
    .filter((path) => count(show("HEAD", path)) > 0);
  if (!tests.length) return finish("fail-first", []);
  const code = codeUnderTest(entries);
  if (!code.length) {
    return finish("fail-first", [`the PR changes tests but no code they test, so its new tests cannot fail on the old code`]);
  }
  const root = process.cwd();
  const command = detectTestCommand(root);
  const dir = mkdtempSync(join(tmpdir(), "fail-first-"));
  const problems = [];
  try {
    git("worktree", "add", "--detach", "-q", dir, "HEAD");
    linkDependencies(root, dir);
    for (const e of code) {
      if (e.status === "A") rmSync(join(dir, e.path), { force: true });
      else {
        if (e.status === "R") rmSync(join(dir, e.path), { force: true });
        const old = e.oldPath || e.path;
        mkdirSync(dirname(join(dir, old)), { recursive: true });
        writeFileSync(join(dir, old), show(from, old));
      }
    }
    for (const path of tests) {
      const run = spawnSync("sh", ["-c", command.replaceAll("{files}", JSON.stringify(path))], {
        cwd: dir, encoding: "utf8", timeout: 10 * 60 * 1000, env: { ...process.env, CI: "true" },
      });
      console.log(`fail-first: ${path} with the old code under test: exit ${run.status ?? "timeout"}`);
      const output = `${run.stdout || ""}${run.stderr || ""}`;
      const verdict = judgeOldRun(run.status, output, show("HEAD", path), code);
      if (verdict === "passes") problems.push(`${path} passes on the code before this PR, so it does not test the change`);
      if (verdict === "setup") {
        console.log(output.split("\n").slice(-30).join("\n"));
        problems.push(`${path} did not show a test failure with the old code, only a setup error (output above); fix the test setup or set TEST_FILE_CMD`);
      }
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
  return finish("fail-first", problems);
}

const SOURCE = /\.([cm]?[jt]sx?)$/;
const NOT_SOURCE = /\.d\.ts$|(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(dist|build|coverage|node_modules|vendor)\//;
const STRYKER = "10.1.1";

const included = (path) => !process.env.MUTATION_INCLUDE || new RegExp(process.env.MUTATION_INCLUDE).test(path);

function allSource() {
  return git("ls-files", "-z").split("\0")
    .filter((path) => path && SOURCE.test(path) && !TEST_FILE.test(path) && !NOT_SOURCE.test(path) && included(path));
}

function mutation(args) {
  // Plants small bugs in the source (flip a comparison, drop a call) and counts how many the tests
  // catch. On a PR only the changed source files are mutated; --all mutates everything (weekly).
  const root = process.cwd();
  let files = [];
  if (!args.all) {
    const from = base();
    files = changedEntries(from)
      .filter((e) => e.status !== "D" && SOURCE.test(e.path) && !TEST_FILE.test(e.path) && !NOT_SOURCE.test(e.path))
      .map((e) => e.path)
      // MUTATION_INCLUDE (a regex) limits planted bugs to code the unit tests cover, for repos
      // whose other code is checked another way (a typecheck, browser checks).
      .filter(included);
    if (!files.length) {
      console.log("mutation: no changed source files to check");
      return 0;
    }
  }
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const runner = deps.vitest ? "vitest" : deps.jest ? "jest" : "command";
  const minimum = Number(process.env.MUTATION_MIN ?? 50);
  const config = {
    testRunner: runner,
    mutate: args.all ? allSource() : files,
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: args.out || "reports/mutation/mutation.json" },
    coverageAnalysis: runner === "command" ? "off" : "perTest",
    thresholds: { high: 80, low: minimum, break: args.all ? null : minimum },
    tempDirName: join(tmpdir(), "stryker-tmp"),
    timeoutMS: 60000,
    concurrency: Number(process.env.MUTATION_CONCURRENCY || 2),
    // The weekly report names tests that catch nothing, so every test must run on every planted bug.
    disableBail: Boolean(args.all),
  };
  if (runner === "command") config.commandRunner = { command: process.env.TEST_CMD || "npm test" };
  const packages = [`@stryker-mutator/core@${STRYKER}`];
  if (runner !== "command") packages.push(`@stryker-mutator/${runner}-runner@${STRYKER}`);
  const stryker = (cfg) => {
    const file = join(mkdtempSync(join(tmpdir(), "stryker-")), "stryker.config.json");
    writeFileSync(file, JSON.stringify(cfg));
    return spawnSync("npx", ["--yes", ...packages.flatMap((p) => ["-p", p]), "stryker", "run", file], { stdio: "inherit" });
  };
  console.log(`mutation: ${args.all ? "all source" : files.join(", ")}; runner ${runner}; must catch ${minimum}% of planted bugs`);
  const run = stryker(config);
  if (args.all && runner === "command") perTestFile(config, stryker, root);
  if (run.status !== 0 && !args.all) {
    console.log(`mutation: blocked. The tests let too many planted bugs through in the changed code. Add checks for the surviving ones listed above, or explain in a "Test changes:" line why they cannot be caught.`);
    return exemption() ? 0 : 1;
  }
  return args.all ? 0 : run.status;
}

export function killedCount(report) {
  return Object.values(report.files || {}).flatMap((f) => f.mutants || [])
    .filter((m) => m.status === "Killed" || m.status === "Timeout").length;
}

function perTestFile(config, stryker, root) {
  // The command runner sees the suite as one test, so the weekly run plants the same bugs once per
  // test file and records how many each file catches alone. Costs one run per test file.
  const out = config.jsonReporter.fileName;
  const command = detectTestCommand(root);
  const testFiles = git("ls-files", "-z").split("\0")
    .filter((path) => path && TEST_FILE.test(path) && /\.([cm]?[jt]sx?)$/.test(path) && count(show("HEAD", path)) > 0);
  const perFile = {};
  for (const path of testFiles) {
    const fileOut = join(mkdtempSync(join(tmpdir(), "per-file-")), "mutation.json");
    stryker({ ...config, reporters: ["json"], jsonReporter: { fileName: fileOut },
      commandRunner: { command: command.replaceAll("{files}", JSON.stringify(path)) } });
    perFile[path] = existsSync(fileOut) ? killedCount(JSON.parse(readFileSync(fileOut, "utf8"))) : null;
    console.log(`mutation: ${path} alone catches ${perFile[path] ?? "?"} planted bugs`);
  }
  if (existsSync(out)) {
    const report = JSON.parse(readFileSync(out, "utf8"));
    writeFileSync(out, JSON.stringify({ ...report, perTestFile: perFile }));
  }
}

export function junitDurations(xml) {
  const out = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*)>/g)) {
    const attr = (name) => (m[1].match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
    const seconds = Number(attr("time"));
    if (Number.isFinite(seconds)) out.push({ name: [attr("classname"), attr("name")].filter(Boolean).join(" > "), seconds });
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

export function zeroKillTests(report) {
  // The command runner reports the whole suite as one test, so it says nothing per test.
  const tests = Object.values(report.testFiles || {}).flatMap((f) => f.tests || []);
  if (tests.length <= 1 && tests.every((t) => t.name === "All tests")) return null;
  const killers = new Set();
  for (const file of Object.values(report.files || {})) {
    for (const mutant of file.mutants || []) for (const id of mutant.killedBy || []) killers.add(id);
  }
  const out = [];
  for (const [path, file] of Object.entries(report.testFiles || {})) {
    for (const test of file.tests || []) if (!killers.has(test.id)) out.push(`${path || "(unknown file)"} > ${test.name}`);
  }
  return out;
}

async function report(args) {
  const junit = args.junit && existsSync(args.junit) ? junitDurations(readFileSync(args.junit, "utf8")) : [];
  const mutation = args.mutation && existsSync(args.mutation) ? JSON.parse(readFileSync(args.mutation, "utf8")) : null;
  const total = junit.reduce((sum, t) => sum + t.seconds, 0);
  const lines = ["Weekly test health. An agent turns this into one cleanup PR: merge or delete tests that catch nothing, speed up slow ones. Never delete a test only because it is slow.", ""];
  lines.push(`## Slowest tests (${junit.length} tests, ${total.toFixed(1)} s total)`);
  for (const t of junit.slice(0, 15)) lines.push(`- ${t.seconds.toFixed(2)} s  ${t.name}`);
  if (!junit.length) lines.push("- no timing report");
  lines.push("", "## Tests that caught none of the planted bugs");
  if (mutation) {
    const zero = zeroKillTests(mutation);
    const mutants = Object.values(mutation.files || {}).flatMap((f) => f.mutants || []);
    const killed = killedCount(mutation);
    lines.push(`Planted bugs caught: ${killed} of ${mutants.length}.`);
    if (zero === null && mutation.perTestFile) {
      const entries = Object.entries(mutation.perTestFile);
      const idle = entries.filter(([, killed]) => killed === 0).map(([path]) => path);
      const unknown = entries.filter(([, killed]) => killed === null).map(([path]) => path);
      lines.push("(per test file: this repo's runner reports the suite as one test)");
      for (const path of idle) lines.push(`- ${path}`);
      for (const path of unknown) lines.push(`- ${path}: not measured (its run failed; check TEST_FILE_CMD)`);
      if (!idle.length && !unknown.length) lines.push("- none");
    } else if (zero === null) lines.push("- not available: this repo's runner reports the suite as one test (use vitest or jest for per-test data)");
    else {
      for (const name of zero.slice(0, 40)) lines.push(`- ${name}`);
      if (!zero.length) lines.push("- none");
    }
  } else lines.push("- no mutation report");
  const body = lines.join("\n");
  console.log(body);
  const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = process.env;
  if (!repo || !token) return 0;
  const api = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...init.headers },
    }).then(async (r) => {
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
      return r.json();
    });
  const title = "Weekly test health";
  const open = await api(`/issues?state=open&labels=test-health&per_page=5`);
  const existing = open.find((i) => i.title === title);
  if (existing) await api(`/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
  else await api(`/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: ["test-health"] }) });
  console.log(`report: ${existing ? "updated" : "opened"} the "${title}" issue`);
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = Object.fromEntries(rest.map((a) => {
    const [key, ...value] = a.replace(/^--/, "").split("=");
    return [key, value.length ? value.join("=") : true];
  }));
  if (command === "guard") return guard();
  if (command === "fail-first") return failFirst();
  if (command === "mutation") return mutation(args);
  if (command === "report") return report(args);
  console.error("usage: test-quality.mjs guard | fail-first | mutation [--all] [--out=FILE] | report [--junit=FILE] [--mutation=FILE]");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`test-quality: ${error.message}`);
    process.exit(1);
  });
}
