import type { TaskInfo } from "./task"

export interface OfflineDownloadAddResult {
  /** Zero-based index in the submitted urls array. */
  index: number
  task_id?: string
  error?: string
}

export interface OfflineDownloadAddData {
  // Older backends and other tools may omit these fields.
  tasks?: TaskInfo[] | null
  results?: OfflineDownloadAddResult[]
}
