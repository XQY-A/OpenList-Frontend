import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { buildI18n } from "./i18n.mjs"

const maxArchiveBytes = 10 * 1024 * 1024
const maxExpandedBytes = 32 * 1024 * 1024
const defaultLock = fileURLToPath(new URL("./i18n-lock.json", import.meta.url))

export function validateLock(lock) {
  if (
    !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(lock.version) ||
    lock.url !==
      `https://github.com/OpenListTeam/OpenList-Frontend/releases/download/${lock.version}/i18n.tar.gz` ||
    !/^[a-f0-9]{64}$/.test(lock.sha256)
  ) {
    throw new Error(
      "The i18n lock must contain an exact official release URL and SHA256",
    )
  }
}

function tarString(buffer) {
  return buffer.toString("utf8").replace(/\0.*$/s, "")
}

function tarNumber(buffer) {
  const text = tarString(buffer).trim()
  if (!/^[0-7]+$/.test(text)) {
    throw new Error("Invalid number in locked i18n archive")
  }
  return Number.parseInt(text, 8)
}

// Read only dictionaries from the verified archive. Never extract links, paths
// outside a language directory, or executable content into the working tree.
export function readLanguageArchive(archive) {
  const expanded = gunzipSync(archive, { maxOutputLength: maxExpandedBytes })
  const dictionaries = new Map()
  let offset = 0
  let ended = false
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      ended = true
      break
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (checksum !== tarNumber(header.subarray(148, 156))) {
      throw new Error("Invalid checksum in locked i18n archive")
    }
    const prefix = tarString(header.subarray(345, 500))
    const rawName = [prefix, tarString(header.subarray(0, 100))]
      .filter(Boolean)
      .join("/")
    const name =
      rawName === "./" ? "." : rawName.replace(/^\.\//, "").replace(/\/$/, "")
    const size = tarNumber(header.subarray(124, 136))
    const type = header[156]
    offset += 512
    if (offset + size > expanded.length) {
      throw new Error("Truncated locked i18n archive")
    }
    if (type === 53) {
      if (
        size !== 0 ||
        (name !== "." && !/^[A-Za-z][A-Za-z0-9-]*$/.test(name))
      ) {
        throw new Error(`Invalid directory in locked i18n archive: ${name}`)
      }
    } else if (type === 48 || type === 0) {
      if (
        !/^[A-Za-z][A-Za-z0-9-]*\/(?:[A-Za-z0-9_]+\.json|entry\.ts)$/.test(name)
      ) {
        throw new Error(`Invalid file in locked i18n archive: ${name}`)
      }
      if (name.endsWith(".json") && !name.startsWith("en/")) {
        if (dictionaries.has(name)) {
          throw new Error(
            `Duplicate dictionary in locked i18n archive: ${name}`,
          )
        }
        const contents = expanded
          .subarray(offset, offset + size)
          .toString("utf8")
        const dictionary = JSON.parse(contents)
        if (
          dictionary === null ||
          typeof dictionary !== "object" ||
          Array.isArray(dictionary)
        ) {
          throw new Error(`Invalid dictionary in locked i18n archive: ${name}`)
        }
        dictionaries.set(name, contents)
      }
    } else {
      throw new Error(`Unsupported entry type in locked i18n archive: ${name}`)
    }
    offset += Math.ceil(size / 512) * 512
  }
  if (!ended || dictionaries.size === 0) {
    throw new Error("Incomplete or empty locked i18n archive")
  }
  const languages = new Set(
    [...dictionaries.keys()].map((name) => name.split("/")[0]),
  )
  for (const language of languages) {
    if (!dictionaries.has(`${language}/index.json`)) {
      throw new Error(
        `Missing language index in locked i18n archive: ${language}`,
      )
    }
  }
  return dictionaries
}

export async function buildLockedI18n({
  root = "./src/lang",
  overrides = "./src/lang-overrides",
  lockPath = defaultLock,
  fetchImpl = fetch,
} = {}) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  validateLock(lock)
  const response = await fetchImpl(lock.url, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Locked i18n download failed: HTTP ${response.status}`)
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > maxArchiveBytes) {
      throw new Error("Locked i18n archive exceeds the size limit")
    }
    chunks.push(chunk)
  }
  const archive = Buffer.concat(chunks)
  const digest = createHash("sha256").update(archive).digest("hex")
  if (digest !== lock.sha256) {
    throw new Error("Locked i18n SHA256 mismatch; no translations were changed")
  }
  const dictionaries = readLanguageArchive(archive)
  const staging = fs.mkdtempSync(path.join(path.dirname(root), ".locked-i18n-"))
  try {
    fs.cpSync(path.join(root, "en"), path.join(staging, "en"), {
      recursive: true,
    })
    for (const [name, contents] of dictionaries) {
      const target = path.join(staging, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    buildI18n({ root: staging, overrides })
    // Recreate generated languages from the lock, excluding stale Crowdin/edge
    // output. The tracked English source and overlays remain untouched.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "en") {
        fs.rmSync(path.join(root, entry.name), { recursive: true })
      }
    }
    for (const entry of fs.readdirSync(staging)) {
      if (entry !== "en") {
        fs.renameSync(path.join(staging, entry), path.join(root, entry))
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  console.log(`Prepared locked i18n ${lock.version} (${lock.sha256})`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildLockedI18n()
}
