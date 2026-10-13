import { debugRest } from "./rest-utils";
import { UiMessageError } from "./i18n/errors";

export type RedfishTaskResponse = {
  status: number;
  statusText?: string;
  headers?: [string, string][];
  body: string;
};

export type RedfishTaskProgress = {
  state: string;
  status: string;
  percentComplete: number | null;
};

export type RedfishTaskMonitorOptions = {
  initial: RedfishTaskResponse;
  fetchTask: (location: string, signal: AbortSignal) => Promise<RedfishTaskResponse>;
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  workflowId?: string;
  onProgress?: (progress: RedfishTaskProgress, response: RedfishTaskResponse) => void;
};

export type RedfishTaskResult = {
  location: string | null;
  response: RedfishTaskResponse;
  progress: RedfishTaskProgress;
};

const headerValue = (headers: [string, string][] | undefined, name: string) =>
  headers?.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";

const taskProgress = (response: RedfishTaskResponse): RedfishTaskProgress => {
  try {
    const value = JSON.parse(response.body) as Record<string, unknown>;
    const percent = typeof value.PercentComplete === "number" ? value.PercentComplete : null;
    return {
      state: typeof value.TaskState === "string" ? value.TaskState : "Unknown",
      status: typeof value.TaskStatus === "string" ? value.TaskStatus : "Unknown",
      percentComplete: percent,
    };
  } catch {
    return { state: "Unknown", status: "Unknown", percentComplete: null };
  }
};

const terminalSuccess = new Set(["completed", "complete", "success", "succeeded"]);
const terminalFailure = new Set(["exception", "killed", "cancelled", "canceled", "critical", "failed", "error"]);

const wait = (signal: AbortSignal, intervalMs: number) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new UiMessageError("Redfish task monitoring was cancelled."));
    return;
  }
  const timer = setTimeout(resolve, intervalMs);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(new UiMessageError("Redfish task monitoring was cancelled."));
  }, { once: true });
});

export async function monitorRedfishTask(options: RedfishTaskMonitorOptions): Promise<RedfishTaskResult> {
  const intervalMs = options.intervalMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (intervalMs < 3_000) throw new UiMessageError("Redfish task polling interval must be at least 3 seconds.");
  const location = headerValue(options.initial.headers, "Location") || null;
  debugRest({ event: "poll.start", operationId: options.workflowId, workflowId: options.workflowId, workflow: "Redfish task", location, intervalMs, timeoutMs, initialStatus: options.initial.status, initialStatusText: options.initial.statusText });
  if (options.initial.status !== 202 || !location) {
    const progress = taskProgress(options.initial);
    if (options.initial.status >= 400) {
      const status = options.initial.status;
      throw new UiMessageError("Redfish task failed with HTTP {{status}}.", { status });
    }
    return { location, response: options.initial, progress };
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const deadline = Date.now() + timeoutMs;
  let response = options.initial;
  let previousState = "";
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      await wait(controller.signal, intervalMs);
      const started = performance.now();
      attempt += 1;
      response = await options.fetchTask(location, controller.signal);
      const progress = taskProgress(response);
      debugRest({ event: "poll.progress", operationId: options.workflowId, workflowId: options.workflowId, correlationId: options.workflowId, workflow: "Redfish task", location, attempt, state: progress.state, previousState, stateTransition: previousState ? `${previousState}->${progress.state}` : progress.state, status: progress.status, percentComplete: progress.percentComplete, responseStatus: response.status, responseStatusText: response.statusText, durationMs: Math.round(performance.now() - started) });
      previousState = progress.state;
      options.onProgress?.(progress, response);
      const state = `${progress.state} ${progress.status}`.toLowerCase();
      if (terminalFailure.has(progress.state.toLowerCase()) || terminalFailure.has(progress.status.toLowerCase()) || response.status >= 400) {
        throw new UiMessageError("Redfish task failed ({{state}}, HTTP {{status}}).", { state: progress.state || progress.status, status: response.status });
      }
      if (terminalSuccess.has(progress.state.toLowerCase()) || terminalSuccess.has(progress.status.toLowerCase())) {
        return { location, response, progress };
      }
      if (state.includes("complete") || state.includes("success")) return { location, response, progress };
    }
    throw new UiMessageError("Redfish task timed out after {{seconds}} seconds.", { seconds: Math.ceil(timeoutMs / 1000) }, "timeout");
  } finally {
    debugRest({ event: "poll.stop", operationId: options.workflowId, workflowId: options.workflowId, correlationId: options.workflowId, workflow: "Redfish task", location, attempt, state: previousState, stopReason: options.signal?.aborted ? "cancelled" : "completed" });
    options.signal?.removeEventListener("abort", abortFromCaller);
    controller.abort();
  }
}
