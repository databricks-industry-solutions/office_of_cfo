// Single source for the AI ROI data disclosure and its honest limits.
//
// Rendered in two places: the Provenance page's limitations card, and the
// "About this data" panel in the shared AI ROI page shell (so the synthetic-data
// disclosure stays reachable from every AI ROI page now that Provenance is out of
// the nav). Plain data with no component imports, so `shared.tsx` can read it
// without an import cycle through ProvenancePanels.

export interface AiRoiLimitation {
  id: string;
  title: string;
  body: string;
}

export const AI_ROI_LIMITATIONS_TITLE = "What this picture does not include";

/** The disclosure that leads the "About this data" panel. */
export const SYNTHETIC_DATA_NOTE_ID = "synthetic";

export const AI_ROI_LIMITATIONS: readonly AiRoiLimitation[] = [
  {
    id: "external-data",
    title: "Value, investment, and org hierarchy are external data",
    body: "The cost side maps to AI Gateway and billing tables. Value, allocation policy, investment, outcomes, and org hierarchy arrive from your GL, HCM, and operational systems — an integration task, not a product gap.",
  },
  {
    id: "batch-joins",
    title: "Spend-to-revenue joins are batch only",
    body: "Gateway usage is not on a streaming path, so spend-to-value joins carry daily latency. Real-time attribution is deferred.",
  },
  {
    id: "budget-enforcement",
    title: "Budget enforcement is approximate",
    body: "Gateway budgets do not track provisioned throughput; enforcement is a soft limit. Overages remain possible.",
  },
  {
    id: "model-mix",
    title: "Model mix dominates unit economics",
    body: "Cost per unit output varies sharply by model tier. Mix shifts move unit economics more than incremental efficiency gains.",
  },
  {
    id: SYNTHETIC_DATA_NOTE_ID,
    title: "All scenario data is synthetic",
    body: "Every governed number outside the Real workspace AI Gateway telemetry panel is deterministic demo data. Org shape and scale follow public-company profiles — no customer data.",
  },
];
