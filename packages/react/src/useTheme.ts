import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "token-inspect-theme";
const NEXT: Record<ThemeMode, ThemeMode> = { auto: "light", light: "dark", dark: "auto" };

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    /* localStorage may be unavailable */
  }
  return "auto";
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

export interface UseThemeResult {
  mode: ThemeMode;
  isDark: boolean;
  cycle: () => void;
}

/** Theme preference: default follows the OS; cycles auto → light → dark; persisted in localStorage. */
export function useTheme(): UseThemeResult {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  const [osDark, setOsDark] = useState<boolean>(prefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setOsDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const cycle = useCallback(() => {
    setMode((prev) => {
      const next = NEXT[prev];
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const isDark = mode === "dark" || (mode === "auto" && osDark);
  return { mode, isDark, cycle };
}
