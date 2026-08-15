export type RestPollingStopReason = "manual" | "close" | "entry-switch" | "unmount" | "replaced";

import { debugRest } from "./rest-utils";

export type RestPollingOptions = {
  intervalMs: number;
  workflowId?: string;
  operation?: string;
  poll: (signal: AbortSignal, attempt: number) => Promise<{ responseStatus?: number; responseStatusText?: string; state?: string } | void>;
  onError?: (error: unknown, attempt: number) => void;
  onStop?: (reason: RestPollingStopReason) => void;
};

const waitForNextPoll = (signal: AbortSignal, intervalMs: number) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException("Polling was stopped.", "AbortError"));
    return;
  }
  const timeoutId = window.setTimeout(resolve, intervalMs);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timeoutId);
    reject(new DOMException("Polling was stopped.", "AbortError"));
  }, { once: true });
});

export class RestPollingController {
  private abortController: AbortController | null = null;
  private generation = 0;
  private running = false;

  get isRunning() {
    return this.running;
  }

  start(options: RestPollingOptions) {
    this.stop("replaced");
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 3_000) {
      throw new Error("REST polling interval must be at least 3 seconds.");
    }
    const controller = new AbortController();
    const generation = ++this.generation;
    this.abortController = controller;
    this.activeOnStop = options.onStop;
    this.activeOptions = options;
    this.running = true;
    debugRest({ event: "poll.controller.start", operationId: options.workflowId, workflowId: options.workflowId, workflow: options.operation || "REST polling", intervalMs: options.intervalMs });
    void this.run(controller, generation, options);
    return () => this.stop("manual");
  }

  stop(reason: RestPollingStopReason = "manual") {
    if (!this.running && !this.abortController) return;
    this.generation += 1;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    const onStop = this.activeOnStop;
    const activeOptions = this.activeOptions;
    this.activeOnStop = undefined;
    this.activeOptions = undefined;
    debugRest({ event: "poll.controller.stop", operationId: activeOptions?.workflowId, workflowId: activeOptions?.workflowId, workflow: activeOptions?.operation || "REST polling", stopReason: reason });
    onStop?.(reason);
  }

  private activeOnStop: RestPollingOptions["onStop"];
  private activeOptions: RestPollingOptions | undefined;

  private async run(controller: AbortController, generation: number, options: RestPollingOptions) {
    let attempt = 0;
    let previousState = "";
    try {
      while (!controller.signal.aborted && generation === this.generation) {
        attempt += 1;
        const started = performance.now();
        try {
          const result = await options.poll(controller.signal, attempt);
          const state = result?.state || "completed";
          debugRest({ event: "poll.controller.attempt", operationId: options.workflowId, workflowId: options.workflowId, correlationId: options.workflowId, workflow: options.operation || "REST polling", intervalMs: options.intervalMs, attempt, state, previousState, stateTransition: previousState ? `${previousState}->${state}` : state, responseStatus: result?.responseStatus, responseStatusText: result?.responseStatusText, durationMs: Math.round(performance.now() - started) });
          previousState = state;
        } catch (error) {
          if (!controller.signal.aborted) {
            debugRest({ event: "poll.controller.attempt", operationId: options.workflowId, workflowId: options.workflowId, correlationId: options.workflowId, workflow: options.operation || "REST polling", intervalMs: options.intervalMs, attempt, state: "failed", previousState, stateTransition: previousState ? `${previousState}->failed` : "failed", failureType: "polling", durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
            previousState = "failed";
            options.onError?.(error, attempt);
          }
        }
        if (controller.signal.aborted || generation !== this.generation) return;
        await waitForNextPoll(controller.signal, options.intervalMs);
      }
    } catch (error) {
      if (!controller.signal.aborted) options.onError?.(error, attempt);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.abortController = null;
        this.activeOnStop = undefined;
        this.activeOptions = undefined;
        debugRest({ event: "poll.controller.stop", operationId: options.workflowId, workflowId: options.workflowId, correlationId: options.workflowId, workflow: options.operation || "REST polling", stopReason: "manual", attempt, state: previousState });
        options.onStop?.("manual");
      }
    }
  }
}
