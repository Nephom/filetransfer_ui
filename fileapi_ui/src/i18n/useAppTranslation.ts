import { useTranslation } from "react-i18next";
import { translateApp } from "./i18n";

/** Subscribe the component to locale changes but resolve each call against the current locale. */
export function useAppTranslation() {
  useTranslation();
  return { t: translateApp };
}

export function formatQuantity(count: number, singular: string, plural: string) {
  const unit = translateApp(count === 1 ? singular : plural);
  return translateApp("{{quantity}} {{unit}}", { quantity: count, unit });
}
