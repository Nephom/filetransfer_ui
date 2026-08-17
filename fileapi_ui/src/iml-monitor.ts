import type { ImlMonitorState, RestFailureType } from "./rest-contracts";
import { debugRest } from "./rest-utils";

export type ImlMonitorStopReason = "manual" | "close" | "entry-switch" | "unmount" | "replaced";
export type ImlMonitorErrorKind = "transient" | "authentication" | "resource" | "aborted";

export type ImlMonitorError = Error & {
  kind?: ImlMonitorErrorKind;
  failureType?: RestFailureType;
  status?: number;
};

export type ImlMonitorSnapshot<T> = {
  entries: T[];
  receivedAt: number;
  connectionGeneration: number;
  sessionGeneration: number;
};

export type ImlMonitorOptions<T> = {
  intervalMs: number;
  workflowId: string;
  login: (signal: AbortSignal) => Promise<void>;
  discover: (signal: AbortSignal) => Promise<void>;
  fetch: (signal: AbortSignal) => Promise<ImlMonitorSnapshot<T>>;
  onState?: (state: ImlMonitorState) => void;
  onSnapshot?: (snapshot: ImlMonitorSnapshot<T>) => void;
  onError?: (error: ImlMonitorError, retry: number) => void;
  onStop?: (reason: ImlMonitorStopReason) => void;
};

export const classifyImlError = (error: unknown): ImlMonitorErrorKind => {
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  const candidate = error as Partial<ImlMonitorError> | null;
  if (candidate?.kind) return candidate.kind;
  if (candidate?.status === 401 || candidate?.status === 403) return "authentication";
  if (candidate?.status && candidate.status >= 400 && candidate.status < 500) return "resource";
  return "transient";
};

export const reconnectDelayMs = (retry: number, random = Math.random()) => {
  const base = [3_000, 5_000, 10_000, 20_000][Math.max(0, retry - 1)] || 30_000;
  return base + Math.floor(Math.max(0, Math.min(1, random)) * 2_000);
};

const abortError = () => new DOMException("IML monitor was stopped.", "AbortError");

export class ImlMonitorController<T> {
  private abortController: AbortController | null = null;
  private generation = 0;
  private state: ImlMonitorState = "stopped";
  private retry = 0;
  private options: ImlMonitorOptions<T> | null = null;
  private connectionGeneration = 0;
  private sessionGeneration = 0;

  get currentState() { return this.state; }
  get retryCount() { return this.retry; }
  get isRunning() { return this.state !== "stopped" && this.state !== "stopped-by-user"; }

  start(options: ImlMonitorOptions<T>) {
    this.stop("replaced");
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 3_000) {
      throw new Error("IML polling interval must be at least 3 seconds.");
    }
    const controller = new AbortController();
    const generation = ++this.generation;
    this.abortController = controller;
    this.options = options;
    this.retry = 0;
    this.connectionGeneration = 0;
    this.sessionGeneration = 0;
    this.setState("connecting");
    void this.run(controller, generation, options);
    return () => this.stop("manual");
  }

  stop(reason: ImlMonitorStopReason = "manual") {
    if (!this.abortController && this.state === "stopped") return;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
    const options = this.options;
    this.options = null;
    this.retry = 0;
    this.setState(reason === "manual" ? "stopped-by-user" : "stopped");
    debugRest({ event: "iml.monitor.stop", workflowId: options?.workflowId, stopReason: reason });
    options?.onStop?.(reason);
  }

  private setState(state: ImlMonitorState) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.options?.onState?.(state);
    debugRest({ event: "iml.monitor.state", workflowId: this.options?.workflowId, previousState: previous, state });
  }

  private ensureActive(controller: AbortController, generation: number) {
    if (controller.signal.aborted || generation !== this.generation) throw abortError();
  }

  private async connect(controller: AbortController, generation: number, options: ImlMonitorOptions<T>) {
    this.ensureActive(controller, generation);
    await options.login(controller.signal);
    this.ensureActive(controller, generation);
    this.sessionGeneration += 1;
    await options.discover(controller.signal);
    this.ensureActive(controller, generation);
    this.connectionGeneration += 1;
    this.retry = 0;
  }

  private async waitBeforeRetry(controller: AbortController, generation: number) {
    const delay = reconnectDelayMs(this.retry);
    await new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted || generation !== this.generation) return reject(abortError());
      const timer = window.setTimeout(resolve, delay);
      controller.signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
  }

  private async run(controller: AbortController, generation: number, options: ImlMonitorOptions<T>) {
    try {
      await this.connect(controller, generation, options);
      this.setState("monitoring");
      while (true) {
        this.ensureActive(controller, generation);
        try {
          const snapshot = await options.fetch(controller.signal);
          this.ensureActive(controller, generation);
          options.onSnapshot?.(snapshot);
          this.retry = 0;
          await this.waitForPoll(controller, generation, options.intervalMs);
        } catch (error) {
          const typed = error as ImlMonitorError;
          if (classifyImlError(error) === "aborted") return;
          await this.recover(typed, controller, generation, options);
        }
      }
    } catch (error) {
      const typed = error as ImlMonitorError;
      if (classifyImlError(error) !== "aborted") {
        options.onError?.(typed, this.retry);
        this.setState(classifyImlError(error) === "authentication" ? "authentication-failed" : "stopped");
      }
    } finally {
      if (generation === this.generation && this.state !== "stopped-by-user") {
        this.abortController = null;
        this.options = null;
        options.onStop?.("manual");
      }
    }
  }

  private async recover(error: ImlMonitorError, controller: AbortController, generation: number, options: ImlMonitorOptions<T>) {
    const kind = classifyImlError(error);
    options.onError?.(error, this.retry);
    if (kind === "authentication") {
      this.setState("authentication-failed");
      throw error;
    }
    if (kind === "resource") {
      this.setState("stopped");
      throw error;
    }
    this.retry += 1;
    this.setState("disconnected");
    await this.waitBeforeRetry(controller, generation);
    this.ensureActive(controller, generation);
    this.setState("reconnecting");
    await this.connect(controller, generation, options);
    this.setState("monitoring");
  }

  private async waitForPoll(controller: AbortController, generation: number, intervalMs: number) {
    await new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted || generation !== this.generation) return reject(abortError());
      const timer = window.setTimeout(resolve, intervalMs);
      controller.signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
  }
}
