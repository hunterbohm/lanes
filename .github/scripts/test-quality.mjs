#!/usr/bin/env node
// Test-quality checks for agent-written PRs. Copy to .github/scripts/test-quality.mjs; no dependencies.
//
//   guard       block test tampering: deleted or skipped tests, a lower test count, `.only`,
//               loosened assertions, and test-runner ignore settings (agents do this to get a pass).
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
const ASSERT = /\bexpect\s*\(|\bassert\b|\bassert\.|\bt\.(?:equal|deepEqual|ok|is)\b/;
const WEAK = /\.toBeTruthy\(\)|\.toBeDefined\(\)|\.not\.toBeNull\(\)|expect\.anything\(\)|\.toBeGreaterThanOrEqual\(0\)|>=\s*0\b|\bassert\s+True\b|assert\.ok\(\s*true\s*\)|\bassert\s+\w+\s+is\s+not\s+None\s*$/;

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

export function guardDiff(entries, read) {
  // entries: [{status, path, oldPath}]; read(side, path) -> file text. Pure, so it is unit-tested.
  const problems = [];
  let before = 0;
  let after = 0;
  for (const { status, path, oldPath } of entries) {
    if (/^\.github\/(scripts\/test-quality\.mjs|workflows\/)/.test(path)) problems.push(`${path}: changes the CI checks themselves`);
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

function guard() {
  const from = base();
  const entries = changedEntries(from);
  return finish("test guard", guardDiff(entries, (side, path) => show(side === "base" ? from : "HEAD", path)));
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
const CODE_UNDER_TEST = /\.([cm]?[jt]sx?|py|go|rb|rs|java|kt|swift)$/;
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
