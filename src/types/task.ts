export interface TaskInfo {
  id: string
  name: string
  creator: string
  creator_role: number
  state: number
  status: string
  progress: number
  start_time: string | null
  end_time: string | null
  total_bytes: number
  error: string
  tool?: string
  source_url?: string
  info_hash?: string
  submission_state?: string
  cloud_delete_state?: string
  can_delete_cloud_record?: boolean
  cloud_delete_unavailable_reason?: string
}
