import test from "node:test"
import assert from "node:assert/strict"
import { classifyOfflineDownloadResponse } from "./offline_download_115.ts"

const response = (results, ids, code = 200) => ({
  code,
  message: "fixture",
  data: {
    tasks: ids.map((id) => ({
      id,
      tool: "115 Open",
      info_hash: "",
      submission_state: "not_submitted",
    })),
    results,
  },
})

const classify = (urls, resp) =>
  classifyOfflineDownloadResponse("115 Open", urls, resp)

test("partial success retains only failed inputs, using request indices", () => {
  const urls = ["magnet:?a", "magnet:?b", "magnet:?c"]
  const outcome = classify(
    urls,
    response(
      [
        { index: 2, task_id: "task-c" },
        { index: 0, task_id: "task-a" },
        { index: 1, error: "save failed" },
      ],
      ["task-c", "task-a"],
    ),
  )
  assert.equal(outcome.kind, "results")
  assert.deepEqual(outcome.retryUrls, ["magnet:?b"])
  assert.deepEqual(outcome.created, [
    { index: 0, url: urls[0], taskId: "task-a" },
    { index: 2, url: urls[2], taskId: "task-c" },
  ])
  assert.deepEqual(outcome.failed, [
    { index: 1, url: urls[1], error: "save failed" },
  ])
  assert.deepEqual(urls, ["magnet:?a", "magnet:?b", "magnet:?c"])
})

test("an empty asynchronous hash does not turn a created task into a failure", () => {
  const outcome = classify(
    ["magnet:?a"],
    response([{ index: 0, task_id: "task-a" }], ["task-a"]),
  )
  assert.equal(outcome.kind, "results")
  assert.deepEqual(outcome.retryUrls, [])
  assert.equal(outcome.created[0].taskId, "task-a")
})

test("all-failed 500 and blank-input 400 preserve indexed errors", () => {
  for (const [urls, code] of [
    [["magnet:?a", "magnet:?b"], 500],
    [["", "  "], 400],
  ]) {
    const outcome = classify(
      urls,
      response(
        urls.map((_, index) => ({ index, error: `failure-${index}` })),
        [],
        code,
      ),
    )
    assert.equal(outcome.kind, "results")
    assert.deepEqual(outcome.retryUrls, urls)
    assert.deepEqual(
      outcome.failed.map((entry) => entry.index),
      [0, 1],
    )
  }
  assert.equal(classify([], response([], [], 400)).kind, "results")
})

test("duplicate URLs are matched by their index, never by the URL text", () => {
  const outcome = classify(
    ["same", "same"],
    response(
      [
        { index: 1, error: "failed" },
        { index: 0, task_id: "task-a" },
      ],
      ["task-a"],
    ),
  )
  assert.equal(outcome.kind, "results")
  assert.equal(outcome.created[0].index, 0)
  assert.equal(outcome.failed[0].index, 1)
})

test("incomplete, repeated and out-of-range indices never produce retry inputs", () => {
  const cases = [
    [{ index: 0, task_id: "task-a" }],
    [
      { index: 0, task_id: "task-a" },
      { index: 0, error: "failed" },
    ],
    [
      { index: 0, task_id: "task-a" },
      { index: 2, error: "failed" },
    ],
    [
      { index: 0, task_id: "task-a" },
      { index: -1, error: "failed" },
    ],
    [
      { index: 0, task_id: "task-a" },
      { index: 0.5, error: "failed" },
    ],
    [
      { index: 0, task_id: "task-a" },
      { index: "1", error: "failed" },
    ],
  ]
  for (const results of cases) {
    const outcome = classify(["a", "b"], response(results, ["task-a"]))
    assert.equal(outcome.kind, "unknown")
    assert.equal("retryUrls" in outcome, false)
    assert.deepEqual(outcome.taskIds, ["task-a"])
  }
})

test("success receipts must match the complete, unique saved task list", () => {
  const cases = [
    response([{ index: 0, task_id: "task-a" }], []),
    response([{ index: 0, task_id: "task-a" }], ["task-b"]),
    response([{ index: 0, task_id: "task-a" }], ["task-a", "task-b"]),
    response([{ index: 0, task_id: "task-a" }], ["task-a", "task-a"]),
    response([{ index: 0, error: "failed" }], ["task-a"], 500),
    response([{ index: 0, task_id: "task-a" }], ["task-a"], 500),
    { code: 200, data: { results: [{ index: 0, task_id: "task-a" }] } },
  ]
  for (const resp of cases) {
    assert.equal(classify(["a"], resp).kind, "unknown")
  }
  assert.equal(
    classify(
      ["a", "b"],
      response(
        [
          { index: 0, task_id: "task-a" },
          { index: 1, task_id: "task-a" },
        ],
        ["task-a"],
      ),
    ).kind,
    "unknown",
  )
})

test("ambiguous or malformed per-item outcomes must be checked in the task list", () => {
  for (const result of [
    null,
    { index: 0 },
    { index: 0, task_id: "task-a", error: "also failed" },
    { index: 0, task_id: 123 },
    { index: 0, error: "  " },
    { index: 0, task_id: "task-a", error: null },
  ]) {
    assert.equal(
      classify(["a"], response([result], ["task-a"])).kind,
      "unknown",
    )
  }
  for (const results of [null, {}, "invalid"]) {
    assert.equal(
      classify(["a"], { code: 200, data: { tasks: [], results } }).kind,
      "unknown",
    )
  }
})

test("old successful backends do not require new metadata or results", () => {
  for (const data of [undefined, null, {}, { tasks: [{ id: "old-task" }] }]) {
    assert.equal(classify(["a"], { code: 200, data }).kind, "legacy")
  }
  const withoutMetadata = {
    code: 200,
    data: {
      tasks: [{ id: "old-task" }],
      results: [{ index: 0, task_id: "old-task" }],
    },
  }
  assert.equal(classify(["a"], withoutMetadata).kind, "results")
})

test("other tools keep their normal response behavior", () => {
  for (const code of [200, 400, 500]) {
    assert.equal(
      classifyOfflineDownloadResponse("aria2", ["a"], {
        code,
        data: { results: "unrelated" },
      }).kind,
      "legacy",
    )
  }
})

test("transport failures and old partial failures cannot be blindly resubmitted", () => {
  for (const resp of [
    undefined,
    null,
    "Bad gateway",
    { code: undefined, message: "network error" },
    { code: -1 },
    { code: 502 },
    { code: 500, data: { tasks: [{ id: "saved" }] } },
  ]) {
    const outcome = classify(["a", "b"], resp)
    assert.equal(outcome.kind, "unknown")
    assert.equal("retryUrls" in outcome, false)
  }
  for (const code of [400, 401, 403]) {
    assert.equal(
      classify(["a"], { code, message: "preflight rejected" }).kind,
      "legacy",
    )
  }
})
