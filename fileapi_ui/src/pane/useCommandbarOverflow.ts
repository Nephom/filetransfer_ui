import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Collapses a toolbar's action buttons into a "More actions" menu when they do
 * not fit. One instance per toolbar element (each Pane window has its own).
 *
 * The decision uses the intrinsic widths of every child (not the flex
 * container's scrollWidth, which describes intermediate layout states), and
 * remembers the width measured while everything was rendered so the full
 * toolbar is only restored once that much space is really available.
 */
export function useCommandbarOverflow() {
  const elementRef = useRef<HTMLElement | null>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const overflowRef = useRef(false);
  const requiredWidthRef = useRef<number | null>(null);

  const setRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
    setElement(node);
  }, []);

  useEffect(() => {
    const commandbar = element;
    if (!commandbar) return undefined;
    const measure = () => {
      if (commandbar.clientWidth === 0) return; // hidden (minimized) window: nothing to measure
      const actionButtons = Array.from(commandbar.querySelectorAll<HTMLButtonElement>(":scope > button"));
      if (overflowRef.current && requiredWidthRef.current !== null) {
        if (commandbar.clientWidth < requiredWidthRef.current) return;
        overflowRef.current = false;
        requiredWidthRef.current = null;
        setOverflow(false);
        return;
      }
      const nonActionWidth = Array.from(commandbar.children)
        .filter((child) => !(child instanceof HTMLButtonElement) && !child.classList.contains("divider"))
        .reduce((width, child) => width + child.getBoundingClientRect().width, 0);
      const dividerWidth = Array.from(commandbar.children)
        .filter((child) => child.classList.contains("divider"))
        .reduce((width, child) => width + child.getBoundingClientRect().width, 0);
      const gap = Number.parseFloat(getComputedStyle(commandbar).gap) || 0;
      const requiredWidth = nonActionWidth
        + actionButtons.reduce((width, button) => width + button.scrollWidth, 0)
        + dividerWidth
        + (commandbar.children.length - 1) * gap;
      const next = requiredWidth > commandbar.clientWidth + 1;
      overflowRef.current = next;
      requiredWidthRef.current = next ? requiredWidth : null;
      setOverflow(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(commandbar);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [element]);

  return { setRef, element, overflow };
}
