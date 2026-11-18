import assert from "node:assert/strict"
import test from "node:test"
import {
  clearTaskTargets,
  cloudDeleteUnavailableReason,
  confirmedDeletedTaskIds,
  parseTaskDeleteResponse,
  sourceFileDeleteUnavailableReason,
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

test("source file deletion requires an explicit server capability and cloud eligibility", () => {
  const reason = (extra = {}, type = "offline_download") =>
    sourceFileDeleteUnavailableReason(
      task("a", { can_delete_source_file: true, ...extra }),
      type,
    )
  assert.equal(reason(), "")
  for (const value of [undefined, false, "true", 1]) {
    assert.equal(
      reason({ can_delete_source_file: value }),
      "source_file_capability_unavailable",
    )
  }
  assert.equal(reason({ tool: "115 Cloud" }), "unsupported_tool")
  assert.equal(reason({}, "offline_download_transfer"), "unsupported_tool")
  assert.equal(
    reason({
      can_delete_cloud_record: false,
      cloud_delete_unavailable_reason: "account_changed",
    }),
    "account_changed",
  )
})

test("all four deletion actions require a confirmed file result when files are requested", () => {
  for (const action of [
    "delete",
    "delete_some",
    "clear_done",
    "clear_succeeded",
  ]) {
    const result = {
      ...removed("a"),
      source_file_delete_state: "deleted",
    }
    const response = {
      code: 200,
      data: action === "delete" ? result : { results: [result] },
    }
    assert.deepEqual(
      confirmedDeletedTaskIds(
        parseTaskDeleteResponse(response, request(action, "a"), true, true),
      ),
      ["a"],
      action,
    )
    const oldResult = removed("a")
    response.data = action === "delete" ? oldResult : { results: [oldResult] }
    const unconfirmed = parseTaskDeleteResponse(
      response,
      request(action, "a"),
      true,
      true,
    )
    assert.deepEqual(confirmedDeletedTaskIds(unconfirmed), [], action)
    assert.equal(unconfirmed[0].cloud_state, "deleted", action)
    assert.equal(unconfirmed[0].source_file_delete_state, "unknown", action)
    assert.equal(
      unconfirmed[0].reason,
      "source_file_delete_unconfirmed",
      action,
    )
  }
})

test("unconfirmed and malformed file acknowledgements cannot remove a task", () => {
  for (const fileState of ["none", "deleting", "unknown", "invalid", null, 1]) {
    const results = parseTaskDeleteResponse(
      {
        code: 200,
        data: { ...removed("a"), source_file_delete_state: fileState },
      },
      request("delete", "a"),
      true,
      true,
    )
    assert.deepEqual(confirmedDeletedTaskIds(results), [], String(fileState))
    assert.equal(results[0].code, 500, String(fileState))
  }
})

test("file deletion and local persistence failures retain their separate cloud evidence", () => {
  const results = parseTaskDeleteResponse(
    {
      code: 200,
      data: {
        results: [
          { ...removed("success"), source_file_delete_state: "deleted" },
          {
            task_id: "file-unknown",
            local_deleted: false,
            cloud_state: "deleted",
            source_file_delete_state: "unknown",
            code: 409,
            reason: "source_file_delete_unconfirmed",
          },
          {
            task_id: "db-failure",
            local_deleted: false,
            cloud_state: "deleted",
            source_file_delete_state: "deleted",
            code: 500,
            reason: "persistence_failed",
          },
        ],
      },
    },
    request("delete_some", "success", "file-unknown", "db-failure"),
    true,
    true,
  )
  assert.deepEqual(confirmedDeletedTaskIds(results), ["success"])
  assert.equal(results[1].cloud_state, "deleted")
  assert.equal(results[1].source_file_delete_state, "unknown")
  assert.equal(results[1].reason, "source_file_delete_unconfirmed")
  assert.equal(results[2].cloud_state, "deleted")
  assert.equal(results[2].source_file_delete_state, "deleted")
  assert.equal(results[2].reason, "persistence_failed")
})

test("empty and lost responses retain an unknown source file result", () => {
  for (const response of [
    { code: 200, data: null },
    { code: undefined, message: "Network Error" },
  ]) {
    const results = parseTaskDeleteResponse(
      response,
      request("delete_some", "a", "b"),
      true,
      true,
    )
    assert.deepEqual(confirmedDeletedTaskIds(results), [])
    assert.ok(
      results.every(
        (result) =>
          result.cloud_state === "unknown" &&
          result.source_file_delete_state === "unknown",
      ),
    )
  }
})
