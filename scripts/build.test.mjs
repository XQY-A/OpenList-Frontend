import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const buildScript = fileURLToPath(new URL("../build.sh", import.meta.url))

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openlist-build-test-"),
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  fs.writeFileSync(path.join(directory, "package.json"), '{"version":"4.2.9"}')
  fs.writeFileSync(path.join(directory, ".gitignore"), "dist/\ncommands.log\n")
  git("init", "--quiet")
  git("add", "package.json", ".gitignore")
  git(
    "-c",
    "user.name=Build Test",
    "-c",
    "user.email=build-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "test fixture",
  )
  return { directory, commit: git("rev-parse", "HEAD") }
}

function build(directory, options = [], env = {}) {
  // Exercise the real orchestration and Git metadata with dependency/network
  // commands replaced. These tests never install dependencies or fetch assets.
  return spawnSync(
    "bash",
    [
      "-c",
      `
    source "$1"
    shift
    pnpm() {
      printf 'pnpm %s\\n' "$*" >> commands.log
      if [[ "$1" == "build" ]]; then
        mkdir -p dist
        if [[ "$TEST_BUILD_DIRTY" == "true" ]]; then
          printf '\\n' >> package.json
        fi
      fi
    }
    node() {
      if [[ "$1" == "./scripts/i18n-locked.mjs" || "$1" == "./scripts/i18n.mjs" ]]; then
        printf 'node %s\\n' "$1" >> commands.log
        if [[ "$1" == "./scripts/i18n-locked.mjs" && "$TEST_LOCK_FAIL" == "true" ]]; then
          return 1
        fi
      else
        command node "$@"
      fi
    }
    fetch_i18n_from_release() {
      printf 'fetch %s\\n' "$*" >> commands.log
    }
    main "$@"
  `,
      "build-test",
      buildScript,
      "--dev",
      "--no-compress",
      ...options,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENLIST_FRONTEND_BUILD_MODE: "dev",
        OPENLIST_FRONTEND_BUILD_COMPRESS: "false",
        OPENLIST_FRONTEND_BUILD_ENFORCE_TAG: "false",
        OPENLIST_FRONTEND_BUILD_SKIP_I18N: "false",
        OPENLIST_FRONTEND_BUILD_LOCKED_I18N: "false",
        ...env,
      },
    },
  )
}

test("locked builds install frozen dependencies and write complete clean source metadata", (t) => {
  const { directory, commit } = fixture(t)
  const result = build(directory, ["--locked-i18n"])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const read = (file) => fs.readFileSync(path.join(directory, file), "utf8")
  assert.equal(read("dist/SOURCE_COMMIT"), commit)
  assert.equal(read("dist/SOURCE_DIRTY"), "false")
  assert.match(read("dist/VERSION"), /^v4\.2\.9-[a-f0-9]+$/)
  assert.match(read("commands.log"), /pnpm install --frozen-lockfile/)
  assert.match(read("commands.log"), /node .\/scripts\/i18n-locked.mjs/)
  assert.doesNotMatch(read("commands.log"), /crowdin|i18n:release|fetch /)
})

test("locked i18n failures stop the build without floating fallback or a dist receipt", (t) => {
  const { directory } = fixture(t)
  const result = build(directory, ["--locked-i18n"], { TEST_LOCK_FAIL: "true" })
  assert.notEqual(result.status, 0)
  const commands = fs.readFileSync(path.join(directory, "commands.log"), "utf8")
  assert.doesNotMatch(commands, /crowdin|fetch |pnpm build/)
  assert.equal(fs.existsSync(path.join(directory, "dist/SOURCE_COMMIT")), false)
})

test("dirty worktrees and changes during a build are explicitly marked", async (t) => {
  for (const kind of ["tracked", "untracked", "during build"]) {
    await t.test(kind, (t) => {
      const { directory, commit } = fixture(t)
      if (kind === "tracked")
        fs.appendFileSync(path.join(directory, "package.json"), "\n")
      if (kind === "untracked")
        fs.writeFileSync(path.join(directory, "new-code.ts"), "export {}\n")
      const result = build(directory, ["--locked-i18n"], {
        TEST_BUILD_DIRTY: String(kind === "during build"),
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.equal(
        fs.readFileSync(path.join(directory, "dist/SOURCE_COMMIT"), "utf8"),
        commit,
      )
      assert.equal(
        fs.readFileSync(path.join(directory, "dist/SOURCE_DIRTY"), "utf8"),
        "true",
      )
    })
  }
})

test("locked and skip i18n options cannot silently override one another", (t) => {
  const { directory } = fixture(t)
  const result = build(directory, ["--locked-i18n", "--skip-i18n"])
  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(path.join(directory, "commands.log")), false)
})
