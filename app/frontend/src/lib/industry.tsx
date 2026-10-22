import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setActiveIndustry } from "../api";
import { useInstalledIndustries } from "./deployment";
import {
  DEFAULT_INDUSTRY, INDUSTRIES, Industry, Overlay, getOverlay,
} from "./industries";

const INDUSTRY_KEY = "cfo.industry";

// Back-compat: the former "retail" overlay is now "consumer".
const ALIASES: Record<string, Industry> = { retail: "consumer" };

function readStored(): Industry {
  try {
    const raw = localStorage.getItem(INDUSTRY_KEY);
    const v = (raw && ALIASES[raw]) || (raw as Industry | null);
    if (v && INDUSTRIES.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_INDUSTRY;
}

// Prime the api module synchronously at import time so the X-Industry header is
// set before the first request fires (App loads data on mount).
setActiveIndustry(readStored());

interface IndustryContextValue {
  industry: Industry;
  overlay: Overlay;
  setIndustry: (id: Industry) => void;
}

const IndustryContext = createContext<IndustryContextValue | null>(null);

export function IndustryProvider({ children }: { children: ReactNode }) {
  const [industry, setIndustryState] = useState<Industry>(readStored);

  const setIndustry = useCallback((id: Industry) => {
    setActiveIndustry(id);
    try {
      localStorage.setItem(INDUSTRY_KEY, id);
    } catch {
      /* ignore */
    }
    setIndustryState(id);
  }, []);

  // A browser can remember an industry this deployment did not install; switch to
  // the first installed one once the deployment is known (the backend already
  // falls back the same way, so the brief first render reads valid data).
  const installed = useInstalledIndustries();
  useEffect(() => {
    if (!installed.includes(industry)) setIndustry(installed[0]);
  }, [installed, industry, setIndustry]);

  const overlay = getOverlay(industry);

  useEffect(() => {
    document.title = `Office of the CFO · ${overlay.label}`;
  }, [overlay.label]);

  const value = useMemo<IndustryContextValue>(
    () => ({ industry, overlay, setIndustry }),
    [industry, overlay, setIndustry]);

  return <IndustryContext.Provider value={value}>{children}</IndustryContext.Provider>;
}

export function useIndustry(): IndustryContextValue {
  const ctx = useContext(IndustryContext);
  if (!ctx) throw new Error("useIndustry must be used within an IndustryProvider");
  return ctx;
}

/** Convenience hook returning just the active overlay. */
export function useOverlay(): Overlay {
  return useIndustry().overlay;
}
