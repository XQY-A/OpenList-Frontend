export const createTaskRefresh = (
  fetchTasks: () => Promise<boolean>,
  automatic: boolean,
) => {
  let pending: Promise<boolean> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const refresh = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (pending) return pending
    clearTimeout(timer)
    timer = undefined
    pending = Promise.resolve()
      .then(() => (disposed ? false : fetchTasks()))
      .finally(() => {
        pending = undefined
        if (automatic && !disposed) {
          // Measure the delay from completion, including failed requests.
          timer = setTimeout(() => {
            // The caller reports request errors; polling must keep running.
            void refresh().catch(() => {})
          }, 5000)
        }
      })
    return pending
  }

  const refreshAfterChange = async () => {
    // A mutation needs a new snapshot, but must not overlap an older request.
    await pending?.catch(() => false)
    return refresh()
  }

  const dispose = () => {
    disposed = true
    clearTimeout(timer)
    timer = undefined
  }

  return { refresh, refreshAfterChange, dispose }
}
