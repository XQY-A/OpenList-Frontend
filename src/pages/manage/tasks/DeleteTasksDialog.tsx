import {
  Box,
  Button,
  Checkbox,
  HStack,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
  VStack,
} from "@hope-ui/solid"
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { useT } from "~/hooks"
import { Resp } from "~/types"
import { r } from "~/utils"
import {
  cloudDeleteUnavailableReason,
  confirmedDeletedTaskIds,
  isClearAction,
  parseTaskDeleteResponse,
  sourceFileDeleteUnavailableReason,
  TaskDeleteRequest,
  TaskDeleteResult,
} from "./deletion"

export const DeleteTasksDialog = (props: {
  type: string
  request: TaskDeleteRequest
  onClose: () => void
  onDeleted: (ids: string[]) => void
  refresh: () => Promise<boolean>
}) => {
  const t = useT()
  const cancelId = createUniqueId()
  const [cloud, setCloud] = createSignal(false)
  const [sourceFiles, setSourceFiles] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [results, setResults] = createSignal<TaskDeleteResult[]>()
  const [requestError, setRequestError] = createSignal("")
  const eligible = createMemo(() =>
    props.request.targets.filter(
      (task) => !cloudDeleteUnavailableReason(task, props.type),
    ),
  )
  const sourceFileEligible = createMemo(() =>
    props.request.targets.filter(
      (task) => !sourceFileDeleteUnavailableReason(task, props.type),
    ),
  )
  const successCount = createMemo(
    () => confirmedDeletedTaskIds(results() ?? []).length,
  )
  const reasonText = (reason: string) =>
    t(`tasks.cloud_reason.${reason}`, undefined, t("tasks.cloud_reason.other"))
  const close = () => {
    if (!submitting()) props.onClose()
  }
  const submit = async () => {
    if (submitting() || results() || props.request.targets.length === 0) return
    setSubmitting(true)
    setRequestError("")
    const query = new URLSearchParams()
    if (props.request.action === "delete") {
      query.set("tid", props.request.targets[0].id)
    }
    if (cloud()) query.set("delete_cloud_record", "true")
    if (cloud() && sourceFiles()) query.set("delete_source_file", "true")
    try {
      const response: Resp<unknown> = await r.post(
        `/task/${props.type}/${props.request.action}?${query}`,
        props.request.action === "delete_some"
          ? props.request.targets.map((task) => task.id)
          : undefined,
      )
      const outcome = parseTaskDeleteResponse(
        response,
        props.request,
        cloud(),
        sourceFiles(),
      )
      setResults(outcome)
      props.onDeleted(confirmedDeletedTaskIds(outcome))
    } catch {
      // No response is proof of neither success nor failure. Keep every ID and
      // require a fresh dialog before another explicit cleanup attempt.
      setRequestError(t("tasks.delete_dialog.network_unknown"))
      setResults((current) => current ?? [])
    } finally {
      // Refresh errors do not invalidate an acknowledgement already received.
      try {
        if (!(await props.refresh())) {
          setRequestError(
            (current) => current || t("tasks.delete_dialog.refresh_failed"),
          )
        }
      } catch {
        setRequestError(
          (current) => current || t("tasks.delete_dialog.refresh_failed"),
        )
      }
      setSubmitting(false)
    }
  }
  return (
    <Modal
      opened
      onClose={close}
      size="lg"
      initialFocus={`#${cancelId}`}
      closeOnEsc={!submitting()}
      closeOnOverlayClick={!submitting()}
      scrollBehavior="inside"
    >
      <ModalOverlay />
      <ModalContent maxW="min(40rem, calc(100vw - 2rem))">
        <ModalHeader>{t("tasks.delete_dialog.title")}</ModalHeader>
        <ModalBody>
          <VStack alignItems="stretch" spacing="$3">
            <Text>
              {t(`tasks.delete_dialog.${props.request.action}`, {
                count: props.request.targets.length,
              })}
            </Text>
            <Show when={isClearAction(props.request.action)}>
              <Text size="sm" color="$neutral11">
                {t("tasks.delete_dialog.clear_scope")}
              </Text>
            </Show>
            <Show when={!results() && props.type === "offline_download"}>
              <Checkbox
                checked={cloud()}
                disabled={submitting() || eligible().length === 0}
                onChange={(event) => {
                  setCloud(event.currentTarget.checked)
                  if (!event.currentTarget.checked) setSourceFiles(false)
                }}
              >
                {t("tasks.delete_dialog.delete_cloud")}
              </Checkbox>
              <Checkbox
                checked={sourceFiles()}
                disabled={
                  submitting() || !cloud() || sourceFileEligible().length === 0
                }
                onChange={(event) =>
                  setSourceFiles(event.currentTarget.checked)
                }
              >
                {t("tasks.delete_dialog.delete_source_files")}
              </Checkbox>
              <Text size="sm" color="$neutral11">
                {t(
                  sourceFiles()
                    ? "tasks.delete_dialog.delete_files_notice"
                    : "tasks.delete_dialog.keep_files",
                )}
              </Text>
              <Show when={cloud()}>
                <Text size="sm" color="$warning11">
                  {t("tasks.delete_dialog.recheck")}
                </Text>
              </Show>
            </Show>
            <Show when={!results()}>
              <Box
                maxH="40vh"
                overflowY="auto"
                borderWidth="1px"
                rounded="$md"
                p="$3"
              >
                <VStack alignItems="stretch" spacing="$3">
                  <For each={props.request.targets}>
                    {(task) => (
                      <Box css={{ overflowWrap: "anywhere" }}>
                        <Text size="sm" fontWeight="$medium">
                          {task.name}
                        </Text>
                        <Show when={props.type === "offline_download"}>
                          <Text size="sm" color="$neutral11">
                            {(
                              sourceFiles()
                                ? sourceFileDeleteUnavailableReason(
                                    task,
                                    props.type,
                                  )
                                : cloudDeleteUnavailableReason(task, props.type)
                            )
                              ? reasonText(
                                  sourceFiles()
                                    ? sourceFileDeleteUnavailableReason(
                                        task,
                                        props.type,
                                      )
                                    : cloudDeleteUnavailableReason(
                                        task,
                                        props.type,
                                      ),
                                )
                              : t("tasks.delete_dialog.available")}
                          </Text>
                        </Show>
                      </Box>
                    )}
                  </For>
                </VStack>
              </Box>
            </Show>
            <Show when={results()?.length}>
              <Text role="status" fontWeight="$medium">
                {t("tasks.delete_dialog.summary", {
                  removed: successCount(),
                  retained: results()!.length - successCount(),
                })}
              </Text>
              <Box maxH="40vh" overflowY="auto">
                <VStack alignItems="stretch" spacing="$3">
                  <For each={results()}>
                    {(result) => (
                      <Box css={{ overflowWrap: "anywhere" }}>
                        <Text size="sm" fontWeight="$medium">
                          {props.request.targets.find(
                            (task) => task.id === result.task_id,
                          )?.name ?? result.task_id}
                        </Text>
                        <Text
                          size="sm"
                          color={
                            result.local_deleted ? "$success11" : "$danger11"
                          }
                        >
                          {result.local_deleted
                            ? t("tasks.delete_dialog.removed")
                            : result.reason
                              ? reasonText(result.reason)
                              : result.error ||
                                t("tasks.delete_dialog.retained")}
                        </Text>
                        <Show
                          when={
                            !result.local_deleted &&
                            result.reason &&
                            result.error
                          }
                        >
                          <Text size="sm" color="$neutral11">
                            {result.error}
                          </Text>
                        </Show>
                        <Show when={cloud()}>
                          <Text size="sm" color="$neutral11">
                            {t("tasks.cloud_status_label")}:{" "}
                            {t(
                              `tasks.cloud_state.${result.cloud_state}`,
                              undefined,
                              result.cloud_state,
                            )}
                          </Text>
                        </Show>
                        <Show
                          when={
                            cloud() &&
                            (sourceFiles() ||
                              (result.source_file_delete_state &&
                                result.source_file_delete_state !== "none"))
                          }
                        >
                          <Text size="sm" color="$neutral11">
                            {t("tasks.source_file_status_label")}:{" "}
                            {t(
                              `tasks.source_file_state.${result.source_file_delete_state ?? "unknown"}`,
                              undefined,
                              result.source_file_delete_state,
                            )}
                          </Text>
                        </Show>
                      </Box>
                    )}
                  </For>
                </VStack>
              </Box>
            </Show>
            <Show when={requestError()}>
              <Text role="alert" color="$danger11">
                {requestError()}
              </Text>
            </Show>
          </VStack>
        </ModalBody>
        <ModalFooter>
          <HStack
            w="$full"
            spacing="$2"
            justifyContent="flex-end"
            flexWrap="wrap"
          >
            <Button
              id={cancelId}
              colorScheme="neutral"
              disabled={submitting()}
              onClick={close}
            >
              {results() ? t("tasks.delete_dialog.close") : t("global.cancel")}
            </Button>
            <Show when={!results()}>
              <Button
                colorScheme="danger"
                maxW="$full"
                css={{ whiteSpace: "normal" }}
                height="auto"
                minH="$10"
                py="$2"
                loading={submitting()}
                disabled={submitting() || props.request.targets.length === 0}
                onClick={submit}
              >
                {cloud()
                  ? sourceFiles()
                    ? t("tasks.delete_dialog.confirm_cloud_files")
                    : t("tasks.delete_dialog.confirm_cloud")
                  : t("tasks.delete_dialog.confirm_local")}
              </Button>
            </Show>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
