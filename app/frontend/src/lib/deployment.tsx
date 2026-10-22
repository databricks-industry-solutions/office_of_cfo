import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { INDUSTRIES, Industry } from "./industries";

// What the demo was installed with (scripts/setup.py --company / --industries),
// served from /api/deployment. There is no in-app picker for either. Until the
// request returns (or when it fails) the company is empty, which falls back to the
// generic "Office of the CFO" name, and every industry counts as installed.
interface Deployment {
  company: string;
  industries: Industry[];
}

const DEFAULTS: Deployment = { company: "", industries: INDUSTRIES };
const DeploymentContext = createContext<Deployment>(DEFAULTS);

export function DeploymentProvider({ children }: { children: ReactNode }) {
  const [deployment, setDeployment] = useState<Deployment>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    api.deployment()
      .then((d) => {
        if (cancelled) return;
        const installed = INDUSTRIES.filter((i) => (d.industries ?? []).includes(i));
        setDeployment({
          company: (d.company ?? "").trim(),
          industries: installed.length > 0 ? installed : INDUSTRIES,
        });
      })
      .catch(() => { /* keep the defaults */ });
    return () => { cancelled = true; };
  }, []);

  return <DeploymentContext.Provider value={deployment}>{children}</DeploymentContext.Provider>;
}

/** Configured company name, or "" when none is set. */
export function useCompany(): string {
  return useContext(DeploymentContext).company;
}

/** Industries this deployment installed, in the canonical order. */
export function useInstalledIndustries(): Industry[] {
  return useContext(DeploymentContext).industries;
}
