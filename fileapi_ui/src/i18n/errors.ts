import type { TFunction } from "i18next";
import type { QueueErrorCategory } from "../queue/recovery";

export type MessageValues = Record<string, string | number>;

export class UiMessageError extends Error {
  readonly translationKey: string;
  readonly values: MessageValues;
  readonly queueCategory?: QueueErrorCategory;

  constructor(translationKey: string, values: MessageValues = {}, queueCategory?: QueueErrorCategory) {
    // Keep useful, interpolated English diagnostics on the Error object for
    // classification and logs; renderers localize from the stable key/value
    // pair instead of changing retry semantics.
    super(translationKey.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? `{{${name}}}`)));
    this.name = "UiMessageError";
    this.translationKey = translationKey;
    this.values = values;
    this.queueCategory = queueCategory;
  }
}

export function formatUiError(error: unknown, t: TFunction) {
  if (error instanceof UiMessageError) return t(error.translationKey, error.values);
  return error instanceof Error ? error.message : String(error);
}
