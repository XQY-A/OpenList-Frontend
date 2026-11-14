import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { gzipSync } from "node:zlib"
import { buildI18n } from "./i18n.mjs"
import { buildLockedI18n, readLanguageArchive } from "./i18n-locked.mjs"

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openlist-i18n-test-"),
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, "lang")
  const overrides = path.join(directory, "overrides")
  const source = {
    existing: "Existing",
    cloud: { confirm: "Confirm", keep: "Keep" },
  }
  writeJSON(path.join(root, "en/tasks.json"), source)
  writeJSON(path.join(root, "en/index.json"), { lang: "English" })
  fs.writeFileSync(
    path.join(root, "en/entry.ts"),
    'export { default as tasks } from "./tasks.json"\n',
  )
  const translated = {
    existing: "原有翻译",
    cloud: { confirm: "旧确认", keep: "保留" },
  }
  writeJSON(path.join(root, "zh-CN/tasks.json"), translated)
  writeJSON(path.join(root, "zh-CN/index.json"), { lang: "简体中文" })
  writeJSON(path.join(overrides, "zh-CN/tasks.json"), {
    cloud: { confirm: "删除云端记录" },
  })
  return { directory, root, overrides, source, translated }
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function tar(entries) {
  const chunks = []
  for (const { name, contents = "", type = "0" } of entries) {
    const body = Buffer.from(contents)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write("0000644\0", 100, 8)
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12)
    header.fill(32, 148, 156)
    header.write(type, 156, 1)
    header.write("ustar\0", 257, 6)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8)
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function languageArchive() {
  return tar([
    { name: "./", type: "5" },
    { name: "./zh-CN/", type: "5" },
    { name: "./zh-CN/index.json", contents: '{"lang":"简体中文"}' },
    {
      name: "./zh-CN/tasks.json",
      contents: '{"existing":"已翻译","cloud":{"keep":"保留"}}',
    },
    { name: "./zh-CN/entry.ts", contents: "old release entry" },
    { name: "./fr-FR/index.json", contents: '{"lang":"Français"}' },
    { name: "./en/tasks.json", contents: '{"existing":"old release source"}' },
  ])
}

function lockFixture(directory, archive) {
  const lockPath = path.join(directory, "lock.json")
  const lock = {
    version: "v4.2.9",
    url: "https://github.com/OpenListTeam/OpenList-Frontend/releases/download/v4.2.9/i18n.tar.gz",
    sha256: createHash("sha256").update(archive).digest("hex"),
  }
  writeJSON(lockPath, lock)
  return { lockPath, lock }
}

test("ordinary i18n keeps translations and reapplies tracked overlays after refresh", (t) => {
  const { root, overrides, source, translated } = fixture(t)
  const target = path.join(root, "zh-CN/tasks.json")
  const overlay = fs.readFileSync(
    path.join(overrides, "zh-CN/tasks.json"),
    "utf8",
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    writeJSON(target, translated)
    buildI18n({ root, overrides })
    assert.deepEqual(readJSON(target), {
      existing: "原有翻译",
      cloud: { confirm: "删除云端记录", keep: "保留" },
    })
  }
  assert.deepEqual(readJSON(path.join(root, "en/tasks.json")), source)
  assert.equal(
    fs.readFileSync(path.join(overrides, "zh-CN/tasks.json"), "utf8"),
    overlay,
  )
  assert.equal(
    fs.readFileSync(path.join(root, "zh-CN/entry.ts"), "utf8"),
    fs.readFileSync(path.join(root, "en/entry.ts"), "utf8"),
  )
})

test("i18n fills missing source files before merging overlays", (t) => {
  const { root, overrides, source } = fixture(t)
  fs.rmSync(path.join(root, "zh-CN/tasks.json"))
  buildI18n({ root, overrides })
  assert.deepEqual(readJSON(path.join(root, "zh-CN/tasks.json")), {
    ...source,
    cloud: { confirm: "删除云端记录", keep: "Keep" },
  })
})

test("i18n accepts a BOM in the existing English dictionary without rewriting it", (t) => {
  const { root, overrides } = fixture(t)
  const file = path.join(root, "en/tasks.json")
  const original = "\uFEFF" + fs.readFileSync(file, "utf8")
  fs.writeFileSync(file, original)
  buildI18n({ root, overrides })
  assert.equal(fs.readFileSync(file, "utf8"), original)
  assert.equal(
    readJSON(path.join(root, "zh-CN/tasks.json")).cloud.confirm,
    "删除云端记录",
  )
})

test("invalid overlays fail before modifying generated language files", async (t) => {
  for (const [name, contents] of [
    ["unknown key", { cloud: { typo: "错误" } }],
    ["wrong type", { cloud: { confirm: true } }],
    ["object over string", { existing: { key: "错误" } }],
    ["prototype key", JSON.parse('{"__proto__":{"polluted":"yes"}}')],
  ]) {
    await t.test(name, (t) => {
      const { root, overrides, translated } = fixture(t)
      writeJSON(path.join(overrides, "zh-CN/tasks.json"), contents)
      assert.throws(() => buildI18n({ root, overrides }), /overlay/)
      assert.deepEqual(
        readJSON(path.join(root, "zh-CN/tasks.json")),
        translated,
      )
      assert.equal(fs.existsSync(path.join(root, "zh-CN/entry.ts")), false)
    })
  }
})

test("locked i18n keeps every archive language, applies overlays, and uses current English", async (t) => {
  const { directory, root, overrides, source } = fixture(t)
  const archive = languageArchive()
  const { lockPath, lock } = lockFixture(directory, archive)
  writeJSON(path.join(root, "stale-LANG/index.json"), { lang: "stale output" })
  let calls = 0
  const fetchImpl = async (url, options) => {
    calls++
    assert.equal(url, lock.url)
    assert.ok(options.signal instanceof AbortSignal)
    return new Response(archive)
  }
  await buildLockedI18n({ root, overrides, lockPath, fetchImpl })
  assert.deepEqual(fs.readdirSync(root).sort(), ["en", "fr-FR", "zh-CN"])
  assert.deepEqual(readJSON(path.join(root, "en/tasks.json")), source)
  assert.deepEqual(readJSON(path.join(root, "fr-FR/tasks.json")), source)
  assert.deepEqual(readJSON(path.join(root, "zh-CN/tasks.json")), {
    existing: "已翻译",
    cloud: { keep: "保留", confirm: "删除云端记录" },
  })
  const first = fs.readFileSync(path.join(root, "zh-CN/tasks.json"), "utf8")
  await buildLockedI18n({ root, overrides, lockPath, fetchImpl })
  assert.equal(
    fs.readFileSync(path.join(root, "zh-CN/tasks.json"), "utf8"),
    first,
  )
  assert.equal(calls, 2)
  assert.equal(
    fs.readFileSync(path.join(root, "zh-CN/entry.ts"), "utf8"),
    fs.readFileSync(path.join(root, "en/entry.ts"), "utf8"),
  )
})

test("locked download failures never fall back or change existing translations", async (t) => {
  for (const [name, result, expected] of [
    [
      "HTTP failure",
      () => new Response("unavailable", { status: 503 }),
      /HTTP 503/,
    ],
    [
      "network failure",
      () => {
        throw new Error("network unavailable")
      },
      /network unavailable/,
    ],
    ["wrong digest", () => new Response("wrong archive"), /SHA256 mismatch/],
  ]) {
    await t.test(name, async (t) => {
      const { directory, root, overrides, translated } = fixture(t)
      const { lockPath } = lockFixture(directory, languageArchive())
      let calls = 0
      await assert.rejects(
        buildLockedI18n({
          root,
          overrides,
          lockPath,
          fetchImpl: async () => {
            calls++
            return result()
          },
        }),
        expected,
      )
      assert.equal(calls, 1)
      assert.deepEqual(
        readJSON(path.join(root, "zh-CN/tasks.json")),
        translated,
      )
      assert.equal(
        fs
          .readdirSync(directory)
          .some((name) => name.startsWith(".locked-i18n-")),
        false,
      )
    })
  }
})

test("floating or malformed locks fail before any request", async (t) => {
  for (const mutation of [
    { version: "edge" },
    {
      url: "https://github.com/OpenListTeam/OpenList-Frontend/releases/download/edge/i18n.tar.gz",
    },
    { sha256: "not-a-digest" },
  ]) {
    const { directory, root, overrides } = fixture(t)
    const { lockPath, lock } = lockFixture(directory, languageArchive())
    writeJSON(lockPath, { ...lock, ...mutation })
    await assert.rejects(
      buildLockedI18n({
        root,
        overrides,
        lockPath,
        fetchImpl: () => assert.fail("unexpected network request"),
      }),
      /exact official release/,
    )
  }
})

test("invalid locked overlays leave the previous translations intact", async (t) => {
  const { directory, root, overrides, translated } = fixture(t)
  const archive = languageArchive()
  const { lockPath } = lockFixture(directory, archive)
  writeJSON(path.join(overrides, "zh-CN/tasks.json"), { typo: "错误" })
  await assert.rejects(
    buildLockedI18n({
      root,
      overrides,
      lockPath,
      fetchImpl: async () => new Response(archive),
    }),
    /Unknown translation overlay key/,
  )
  assert.deepEqual(readJSON(path.join(root, "zh-CN/tasks.json")), translated)
  assert.equal(fs.existsSync(path.join(root, "fr-FR")), false)
})

test("archive reader rejects traversal, links, duplicates, malformed dictionaries and missing indexes", () => {
  for (const entries of [
    [{ name: "../outside.json", contents: "{}" }],
    [{ name: "/outside.json", contents: "{}" }],
    [{ name: "zh-CN/index.json", type: "2" }],
    [{ name: "zh-CN/index.json", type: "1" }],
    [
      { name: "zh-CN/index.json", contents: "{}" },
      { name: "zh-CN/index.json", contents: "{}" },
    ],
    [{ name: "zh-CN/index.json", contents: "null" }],
    [{ name: "zh-CN/index.json", contents: "[invalid" }],
    [{ name: "zh-CN/tasks.json", contents: "{}" }],
  ]) {
    assert.throws(() => readLanguageArchive(tar(entries)))
  }
})
