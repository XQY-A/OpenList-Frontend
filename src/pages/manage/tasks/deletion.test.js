import assert from "node:assert/strict"
import test from "node:test"
import {
  clearTaskTargets,
  cloudDeleteUnavailableReason,
  confirmedDeletedTaskIds,
  parseTaskDeleteResponse,
} from "./deletion.ts"

const task = (id, extra = {}) => ({
  id,
  name: `Download ${id}`,
  state: 2,
  tool: "115 Open",
  can_delete_cloud_record: true,
  ...extra,
})
const request = (action, ...ids) => ({
  action,
  targets: ids.map((id) => task(id)),
})
const removed = (id) => ({
  task_id: id,
  local_deleted: true,
  cloud_state: "deleted",
  code: 200,
})

test("a mixed batch removes only acknowledged tasks and retains each specific failure", () => {
  const results = parseTaskDeleteResponse(
    {
      code: 200,
      data: {
        results: [
          removed("accepted"),
          {
            task_id: "other-tool",
            local_deleted: false,
            cloud_state: "none",
            code: 409,
            reason: "unsupported_tool",
            error: "only 115 Open tasks support cloud record deletion",
          },
          {
            task_id: "db-failure",
            local_deleted: false,
            cloud_state: "deleted",
            code: 500,
            reason: "persistence_failed",
            error: "database unavailable",
          },
        ],
      },
    },
    request("delete_some", "accepted", "other-tool", "db-failure"),
    true,
  )
  assert.deepEqual(confirmedDeletedTaskIds(results), ["accepted"])
  assert.equal(results[1].reason, "unsupported_tool")
  assert.equal(results[2].cloud_state, "deleted")
  assert.equal(results[2].error, "database unavailable")
  assert.equal(results[2].local_deleted, false)
})

test("a single failed request preserves the cloud result returned with an HTTP error", () => {
  const failure = {
    task_id: "a",
    local_deleted: false,
    cloud_state: "unknown",
    code: 502,
    reason: "cloud_delete_unknown",
    error: "115 response unavailable",
  }
  const results = parseTaskDeleteResponse(
    { code: 502, message: "failed", data: failure },
    request("delete", "a"),
    true,
  )
  assert.deepEqual(results, [failure])
  assert.deepEqual(confirmedDeletedTaskIds(results), [])
})

test("top-level success cannot hide that every cloud cleanup failed", () => {
  const results = parseTaskDeleteResponse(
    {
      code: 200,
      data: {
        results: ["a", "b"].map((id) => ({
          task_id: id,
          local_deleted: false,
          cloud_state: "none",
          code: 409,
          reason: "cloud_task_active",
        })),
      },
    },
    request("delete_some", "a", "b"),
    true,
  )
  assert.deepEqual(confirmedDeletedTaskIds(results), [])
  assert.equal(results.length, 2)
  assert.ok(results.every((result) => result.reason === "cloud_task_active"))
})

test("an old server's empty 200 response never confirms requested cloud cleanup", () => {
  for (const action of [
    "delete",
    "delete_some",
    "clear_done",
    "clear_succeeded",
  ]) {
    const results = parseTaskDeleteResponse(
      { code: 200, data: null },
      request(action, "a"),
      true,
    )
    assert.deepEqual(confirmedDeletedTaskIds(results), [], action)
    assert.equal(results[0].reason, "response_unconfirmed", action)
  }
})

test("missing, malformed, and contradictory cloud acknowledgements keep their tasks", () => {
  const results = parseTaskDeleteResponse(
    {
      code: 200,
      data: {
        results: [
          { ...removed("unknown-cloud"), cloud_state: "unknown" },
          { ...removed("error-code"), code: 500 },
          { ...removed("malformed"), reason: { message: "not a string" } },
          removed("unrequested"),
        ],
      },
    },
    request(
      "delete_some",
      "missing",
      "unknown-cloud",
      "error-code",
      "malformed",
    ),
    true,
  )
  assert.deepEqual(confirmedDeletedTaskIds(results), [])
  assert.equal(results.length, 4)
  assert.ok(results.every((result) => result.reason === "response_unconfirmed"))
  assert.ok(results.every((result) => result.task_id !== "unrequested"))
})

test("clear also handles acknowledged tasks that finished after the confirmation snapshot", () => {
  const response = {
    code: 200,
    data: { results: [removed("a"), removed("just-finished"), removed("a")] },
  }
  const clearResults = parseTaskDeleteResponse(
    response,
    request("clear_succeeded", "a"),
    true,
  )
  assert.deepEqual(confirmedDeletedTaskIds(clearResults), [
    "a",
    "just-finished",
  ])
  const selectedResults = parseTaskDeleteResponse(
    response,
    request("delete_some", "a"),
    true,
  )
  assert.deepEqual(confirmedDeletedTaskIds(selectedResults), ["a"])
})

test("default local deletion remains compatible with old single, batch, and clear responses", () => {
  for (const action of ["delete", "clear_done", "clear_succeeded"]) {
    const results = parseTaskDeleteResponse(
      { code: 200, data: null },
      request(action, "a"),
      false,
    )
    assert.deepEqual(confirmedDeletedTaskIds(results), ["a"], action)
  }
  const results = parseTaskDeleteResponse(
    {
      code: 200,
      data: { b: "task already retried", c: "database write failed" },
    },
    request("delete_some", "a", "b", "c"),
    false,
  )
  assert.deepEqual(confirmedDeletedTaskIds(results), ["a"])
  assert.equal(results[1].error, "task already retried")
  assert.equal(results[2].error, "database write failed")
})

test("legacy clear errors and network failures do not remove unconfirmed rows", () => {
  const legacy = parseTaskDeleteResponse(
    { code: 500, message: "partial clear failure", data: null },
    request("clear_done", "a", "b"),
    false,
  )
  assert.deepEqual(confirmedDeletedTaskIds(legacy), [])
  assert.ok(legacy.every((result) => result.error === "partial clear failure"))
  for (const cloud of [false, true]) {
    const network = parseTaskDeleteResponse(
      { code: undefined, message: "Network Error" },
      request("delete_some", "a", "b"),
      cloud,
    )
    assert.deepEqual(confirmedDeletedTaskIds(network), [])
    assert.ok(network.every((result) => result.reason === "network_unknown"))
    assert.ok(network.every((result) => result.code === 500))
  }
})

test("clear scope includes all terminal tasks and ignores view-only attributes", () => {
  const tasks = Array.from({ length: 10 }, (_, state) =>
    task(`state-${state}`, {
      state,
      creator: state % 2 ? "another-user" : "me",
    }),
  )
  assert.deepEqual(
    clearTaskTargets(tasks, "clear_done").map((value) => value.id),
    ["state-2", "state-4", "state-7"],
  )
  assert.deepEqual(
    clearTaskTargets(tasks, "clear_succeeded").map((value) => value.id),
    ["state-2"],
  )
})

test("cloud cleanup uses the server tool and capability, never a display name or guessed hash", () => {
  const reason = (value, type = "offline_download") =>
    cloudDeleteUnavailableReason(value, type)
  assert.equal(reason(task("a", { name: "arbitrary translated name" })), "")
  assert.equal(
    reason(task("a", { name: "115 Open download", tool: "aria2" })),
    "unsupported_tool",
  )
  assert.equal(
    reason(task("a", { tool: undefined, info_hash: "looks-valid" })),
    "capability_unavailable",
  )
  assert.equal(
    reason(task("a"), "offline_download_transfer"),
    "unsupported_tool",
  )
  assert.equal(
    reason(task("a", { can_delete_cloud_record: undefined })),
    "capability_unavailable",
  )
  assert.equal(
    reason(
      task("a", {
        can_delete_cloud_record: false,
        cloud_delete_unavailable_reason: "account_changed",
      }),
    ),
    "account_changed",
  )
})
