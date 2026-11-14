import type { TaskInfo } from "~/types"

export type TaskDeleteAction =
  "delete" | "delete_some" | "clear_done" | "clear_succeeded"

export interface TaskDeleteRequest {
  action: TaskDeleteAction
  targets: TaskInfo[]
}

export interface TaskDeleteResult {
  task_id: string
  local_deleted: boolean
  cloud_state: string
  code: number
  reason?: string
  error?: string
}

export const isClearAction = (action: TaskDeleteAction) =>
  action === "clear_done" || action === "clear_succeeded"

export const clearTaskTargets = (tasks: TaskInfo[], action: TaskDeleteAction) =>
  tasks.filter((task) =>
    action === "clear_succeeded"
      ? task.state === 2
      : [2, 4, 7].includes(task.state),
  )

export const cloudDeleteUnavailableReason = (task: TaskInfo, type: string) => {
  if (type !== "offline_download") return "unsupported_tool"
  if (!task.tool) return "capability_unavailable"
  if (task.tool !== "115 Open") return "unsupported_tool"
  if (task.can_delete_cloud_record === true) return ""
  return task.cloud_delete_unavailable_reason || "capability_unavailable"
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isDeleteResult = (value: unknown): value is TaskDeleteResult =>
  isObject(value) &&
  typeof value.task_id === "string" &&
  typeof value.local_deleted === "boolean" &&
  typeof value.cloud_state === "string" &&
  typeof value.code === "number" &&
  Number.isFinite(value.code) &&
  (value.reason === undefined || typeof value.reason === "string") &&
  (value.error === undefined || typeof value.error === "string")

// Cloud cleanup needs a per-item acknowledgement. An old server's empty 200
// response must never be interpreted as confirmation that cloud cleanup ran.
export const parseTaskDeleteResponse = (
  response: { code?: number; message?: string; data?: unknown },
  request: TaskDeleteRequest,
  cloud: boolean,
): TaskDeleteResult[] => {
  const targets = [...new Set(request.targets.map((task) => task.id))]
  const failure = (id: string): TaskDeleteResult => ({
    task_id: id,
    local_deleted: false,
    cloud_state: "unknown",
    code:
      response.code === 200 || !response.code || response.code < 0
        ? 500
        : response.code,
    reason:
      response.code === 200
        ? "response_unconfirmed"
        : !response.code || response.code < 0
          ? "network_unknown"
          : "request_failed",
    error: response.code === 200 ? undefined : response.message,
  })
  if (cloud) {
    const data = response.data
    const raw =
      request.action === "delete"
        ? [data]
        : isObject(data) && Array.isArray(data.results)
          ? data.results
          : []
    const results = new Map<string, TaskDeleteResult>()
    for (const item of raw) {
      if (
        !isDeleteResult(item) ||
        (!isClearAction(request.action) && !targets.includes(item.task_id)) ||
        results.has(item.task_id)
      ) {
        continue
      }
      results.set(
        item.task_id,
        item.local_deleted &&
          (item.code !== 200 || item.cloud_state !== "deleted")
          ? failure(item.task_id)
          : item,
      )
    }
    for (const id of targets) {
      if (!results.has(id)) results.set(id, failure(id))
    }
    return [...results.values()]
  }
  const errors = isObject(response.data) ? response.data : {}
  return targets.map((id) => {
    if (response.code !== 200) return failure(id)
    const error = request.action === "delete_some" ? errors[id] : undefined
    return {
      task_id: id,
      local_deleted: typeof error !== "string",
      cloud_state: "none",
      code: typeof error === "string" ? 500 : 200,
      error: typeof error === "string" ? error : undefined,
    }
  })
}

export const confirmedDeletedTaskIds = (results: TaskDeleteResult[]) =>
  results
    .filter((result) => result.code === 200 && result.local_deleted)
    .map((result) => result.task_id)
