import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as flush } from "node:timers/promises"
import { createTaskRefresh } from "./refresh.ts"

test("slow requests update before the next five-second delay starts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const requests = []
  const updates = []
  const controller = createTaskRefresh(() => {
    const response = Promise.withResolvers()
    requests.push({ started: Date.now(), ...response })
    return response.promise.then((progress) => {
      updates.push(progress)
      return true
    })
  }, true)
  t.after(controller.dispose)

  const first = controller.refresh()
  await flush()
  t.mock.timers.tick(3000)
  assert.equal(controller.refresh(), first)
  t.mock.timers.tick(4000)
  await flush()
  assert.equal(requests.length, 1)
  requests[0].resolve(70)
  assert.equal(await first, true)
  assert.deepEqual(updates, [70])

  t.mock.timers.tick(4999)
  await flush()
  assert.equal(requests.length, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.deepEqual(
    requests.map((request) => request.started),
    [0, 12000],
  )
  const second = controller.refresh()
  requests[1].resolve(90)
  await second
  assert.deepEqual(updates, [70, 90])
})

test("manual refresh resets the delay without leaving an earlier timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const started = []
  const controller = createTaskRefresh(async () => {
    started.push(Date.now())
    return true
  }, true)
  t.after(controller.dispose)

  await controller.refresh()
  t.mock.timers.tick(4000)
  await controller.refresh()
  t.mock.timers.tick(1000)
  await flush()
  assert.deepEqual(started, [0, 4000])
  t.mock.timers.tick(4000)
  await flush()
  assert.deepEqual(started, [0, 4000, 9000])
})

test("polling resumes five seconds after rejected and unsuccessful requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let attempts = 0
  const controller = createTaskRefresh(async () => {
    ++attempts
    if (attempts === 1) throw new Error("request failed")
    return attempts !== 2
  }, true)
  t.after(controller.dispose)

  await assert.rejects(controller.refresh(), /request failed/)
  t.mock.timers.tick(4999)
  await flush()
  assert.equal(attempts, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(attempts, 2)
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(attempts, 3)
})

test("changes wait for the old request and share one fresh snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const requests = []
  const controller = createTaskRefresh(() => {
    const response = Promise.withResolvers()
    requests.push(response)
    return response.promise
  }, true)
  t.after(controller.dispose)

  const old = controller.refresh()
  await flush()
  const afterDelete = controller.refreshAfterChange()
  const afterRetry = controller.refreshAfterChange()
  t.mock.timers.tick(10000)
  await flush()
  assert.equal(requests.length, 1)

  requests[0].resolve(false)
  await old
  await flush()
  assert.equal(requests.length, 2)
  requests[1].resolve(true)
  assert.deepEqual(await Promise.all([afterDelete, afterRetry]), [true, true])
  t.mock.timers.tick(4999)
  await flush()
  assert.equal(requests.length, 2)
})

test("completed task lists only refresh on demand", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let attempts = 0
  const controller = createTaskRefresh(async () => {
    ++attempts
    return true
  }, false)
  t.after(controller.dispose)

  await controller.refresh()
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(attempts, 1)
  await controller.refreshAfterChange()
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(attempts, 2)
  await controller.refresh()
  assert.equal(attempts, 3)
})

test("disposing during a request prevents polling and queued refreshes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const response = Promise.withResolvers()
  let attempts = 0
  const controller = createTaskRefresh(() => {
    ++attempts
    return response.promise
  }, true)
  const pending = controller.refresh()
  await flush()
  const afterChange = controller.refreshAfterChange()
  controller.dispose()
  response.resolve(true)
  await pending
  assert.equal(await afterChange, false)
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(await controller.refresh(), false)
  assert.equal(attempts, 1)
})

test("disposing during the delay cancels the next request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let attempts = 0
  const controller = createTaskRefresh(async () => {
    ++attempts
    return true
  }, true)
  await controller.refresh()
  controller.dispose()
  t.mock.timers.tick(60000)
  await flush()
  assert.equal(await controller.refresh(), false)
  assert.equal(attempts, 1)
})

test("disposing before the request starts prevents it from being sent", async () => {
  let attempts = 0
  const controller = createTaskRefresh(async () => {
    ++attempts
    return true
  }, true)
  const pending = controller.refresh()
  controller.dispose()
  assert.equal(await pending, false)
  assert.equal(attempts, 0)
})
