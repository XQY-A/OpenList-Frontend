import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function readDictionary(file) {
  const dictionary = JSON.parse(
    fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
  )
  if (!isObject(dictionary)) {
    throw new Error(`Translation must be an object: ${file}`)
  }
  return dictionary
}

function mergeOverlay(target, overlay, source, location) {
  if (!isObject(overlay) || !isObject(source)) {
    throw new Error(`Translation overlay must be an object: ${location}`)
  }
  const result = { ...target }
  for (const [key, value] of Object.entries(overlay)) {
    const keyPath = `${location}.${key}`
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !Object.hasOwn(source, key)
    ) {
      throw new Error(`Unknown translation overlay key: ${keyPath}`)
    }
    if (isObject(value)) {
      result[key] = mergeOverlay(result[key], value, source[key], keyPath)
    } else {
      if (typeof value !== "string" || typeof source[key] !== "string") {
        throw new Error(
          `Translation overlay must match a source string: ${keyPath}`,
        )
      }
      result[key] = value
    }
  }
  return result
}

// Both Crowdin and locked release builds apply the same tracked overrides.
export function buildI18n({
  root = "./src/lang",
  overrides = "./src/lang-overrides",
} = {}) {
  const sourceDir = path.join(root, "en")
  const sourceFiles = fs
    .readdirSync(sourceDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
  const languages = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "en")
    .map((entry) => entry.name)
    .sort()
  const writes = new Map()
  for (const language of languages) {
    for (const file of sourceFiles) {
      const target = path.join(root, language, file)
      if (!fs.existsSync(target)) {
        writes.set(target, fs.readFileSync(path.join(sourceDir, file), "utf8"))
      }
    }
  }

  if (fs.existsSync(overrides)) {
    for (const language of fs.readdirSync(overrides, { withFileTypes: true })) {
      if (!language.isDirectory() || !languages.includes(language.name)) {
        throw new Error(
          `Unknown translation overlay language: ${language.name}`,
        )
      }
      const overlayDir = path.join(overrides, language.name)
      for (const file of fs.readdirSync(overlayDir)) {
        if (!file.endsWith(".json") || !sourceFiles.includes(file)) {
          throw new Error(
            `Unknown translation overlay file: ${language.name}/${file}`,
          )
        }
        const target = path.join(root, language.name, file)
        const source = readDictionary(path.join(sourceDir, file))
        const dictionary = fs.existsSync(target)
          ? readDictionary(target)
          : source
        const overlay = readDictionary(path.join(overlayDir, file))
        const merged = mergeOverlay(
          dictionary,
          overlay,
          source,
          `${language.name}/${file}`,
        )
        writes.set(target, `${JSON.stringify(merged, null, 2)}\n`)
      }
    }
  }

  // Validate all overlays before changing any generated translation files.
  for (const [target, contents] of writes) {
    fs.writeFileSync(target, contents)
  }
  for (const language of languages) {
    fs.copyFileSync(
      path.join(sourceDir, "entry.ts"),
      path.join(root, language, "entry.ts"),
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  buildI18n()
}
