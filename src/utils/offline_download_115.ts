export interface CreatedOfflineDownload {
  index: number
  url: string
  taskId: string
}

export interface FailedOfflineDownload {
  index: number
  url: string
  error: string
}

export type OfflineDownloadOutcome =
  | { kind: "legacy" }
  | { kind: "unknown"; taskIds: string[] }
  | {
      kind: "results"
      created: CreatedOfflineDownload[]
      failed: FailedOfflineDownload[]
      retryUrls: string[]
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

/**
 * Only a complete, unambiguous receipt can decide which inputs are safe to retry.
 * Missing new fields remain compatible with old successful responses, but an old
 * error may have occurred after an earlier URL was already added.
 */
export const classifyOfflineDownloadResponse = (
  tool: string,
  urls: readonly string[],
  response: unknown,
): OfflineDownloadOutcome => {
  const resp = isRecord(response) ? response : {}
  const data = isRecord(resp.data) ? resp.data : {}
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const results = Array.isArray(data.results) ? data.results : []
  const taskIds = [
    ...new Set([
      ...tasks.flatMap((task) =>
        isRecord(task) && isNonEmptyString(task.id) ? [task.id] : [],
      ),
      ...results.flatMap((result) =>
        isRecord(result) && isNonEmptyString(result.task_id)
          ? [result.task_id]
          : [],
      ),
    ]),
  ]
  const unknown: OfflineDownloadOutcome = { kind: "unknown", taskIds }

  // The shared request interceptor resolves transport errors without a code.
  if (typeof resp.code !== "number" || resp.code <= 0) return unknown
  if (tool !== "115 Open") return { kind: "legacy" }

  if (!("results" in data)) {
    if (resp.code === 200) return { kind: "legacy" }
    // These rejections happen before the backend starts adding URLs.
    if (taskIds.length === 0 && [400, 401, 403].includes(resp.code)) {
      return { kind: "legacy" }
    }
    return unknown
  }

  if (
    !Array.isArray(data.results) ||
    !Array.isArray(data.tasks) ||
    results.length !== urls.length
  ) {
    return unknown
  }

  const savedIds = new Set<string>()
  for (const task of tasks) {
    if (
      !isRecord(task) ||
      !isNonEmptyString(task.id) ||
      savedIds.has(task.id) ||
      (task.tool !== undefined && task.tool !== "115 Open")
    ) {
      return unknown
    }
    savedIds.add(task.id)
  }

  const seenIndices = new Set<number>()
  const created: CreatedOfflineDownload[] = []
  const failed: FailedOfflineDownload[] = []
  const matchedIds = new Set<string>()
  for (const result of results) {
    if (!isRecord(result)) return unknown
    const index = result.index
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= urls.length ||
      seenIndices.has(index)
    ) {
      return unknown
    }
    seenIndices.add(index)
    const hasTask = isNonEmptyString(result.task_id)
    const hasError = isNonEmptyString(result.error)
    if (
      hasTask === hasError ||
      (result.task_id !== undefined && typeof result.task_id !== "string") ||
      (result.error !== undefined && typeof result.error !== "string")
    ) {
      return unknown
    }
    if (hasTask) {
      const taskId = result.task_id as string
      if (!savedIds.has(taskId) || matchedIds.has(taskId)) return unknown
      matchedIds.add(taskId)
      created.push({ index, url: urls[index], taskId })
    } else {
      failed.push({ index, url: urls[index], error: result.error as string })
    }
  }
  if (
    matchedIds.size !== savedIds.size ||
    (created.length > 0 ? resp.code !== 200 : ![400, 500].includes(resp.code))
  ) {
    return unknown
  }

  created.sort((a, b) => a.index - b.index)
  failed.sort((a, b) => a.index - b.index)
  return {
    kind: "results",
    created,
    failed,
    retryUrls: failed.map((entry) => entry.url),
  }
}
