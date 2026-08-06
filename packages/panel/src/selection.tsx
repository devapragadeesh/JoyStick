import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Selection state shared between the graph view (Part A/B.1) and the chat
 * panel (Part B). One source of truth: selecting a node in the graph and
 * switching to chat must show that selection already applied, not reset it.
 * Lives at the App level, same lifetime as the `tab` state it sits beside —
 * in-memory only, not persisted, matching how tab choice itself already
 * isn't persisted across a reload.
 */

interface SelectionContextValue {
  selected: string[];
  toggle: (filePath: string) => void;
  add: (filePath: string) => void;
  remove: (filePath: string) => void;
  /** Single-select: replaces the whole selection with just this one. */
  replace: (filePath: string) => void;
  clear: () => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = useCallback((filePath: string) => {
    setSelected((prev) => (prev.includes(filePath) ? prev.filter((p) => p !== filePath) : [...prev, filePath]));
  }, []);

  const add = useCallback((filePath: string) => {
    setSelected((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
  }, []);

  const remove = useCallback((filePath: string) => {
    setSelected((prev) => prev.filter((p) => p !== filePath));
  }, []);

  const replace = useCallback((filePath: string) => setSelected([filePath]), []);

  const clear = useCallback(() => setSelected([]), []);

  const value = useMemo(
    () => ({ selected, toggle, add, remove, replace, clear }),
    [selected, toggle, add, remove, replace, clear],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used within SelectionProvider");
  return ctx;
}
