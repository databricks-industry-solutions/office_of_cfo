// Shared chart palette so every chart surface reads as one system. Previously
// copy-pasted per component (VarianceDashboard, CogsBridgeView, the retired
// Bridge Analysis page); now a single source of truth. Semantic keys:
//   accent — identity / selected series · good/bad — favourable/unfavourable
//   warn — caution series · slate — neutral bars · ink — secondary label text
//   seriesA/B/C — non-semantic series · grid — hairlines · axis — tick text
export const CHART_COLORS = {
  accent: "#3E4754",
  good: "#4A7A5C",
  bad: "#9A5A52",
  warn: "#A6843A",
  slate: "#94A3B8",
  ink: "#64748B",
  seriesA: "#3179C9",
  seriesB: "#A98A34",
  seriesC: "#7C6FE0",
  grid: "rgba(23,25,32,0.10)",
  axis: "#8B909A",
  series1: "#C4382B",
  series2: "#1B8A5A",
  series3: "#3D5A80",
  series4: "#A98A34",
  other: "#94A3B8",
} as const;

/** SVG axis typography aligned with the app's Inter/system sans stack.
 * Use DENSE for compact fixed-viewBox charts, the default for standard charts,
 * and PIXEL only when the viewBox maps closely to measured CSS pixels. */
export const CHART_AXIS_TEXT = {
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 400,
} as const;

export const CHART_AXIS_TEXT_DENSE = {
  fontFamily: "inherit",
  fontSize: 9,
  fontWeight: 400,
} as const;

export const CHART_AXIS_TEXT_PIXEL = {
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 400,
} as const;

/** CSS custom properties for Spend stacked-area fills (see index.css). */
export const SPEND_STACKED_AREA_CSS_VARS = {
  brick: "--c-spend-area-brick",
  green: "--c-spend-area-green",
  blue: "--c-spend-area-blue",
  gold: "--c-spend-area-gold",
  slate: "--c-spend-area-slate",
} as const;

export type SpendStackedAreaKey = keyof typeof SPEND_STACKED_AREA_CSS_VARS;

/** Opaque muted fills — must stay in sync with `:root` / `.dark` in index.css. */
export const SPEND_STACKED_AREA = {
  light: {
    brick: "#EBD5D2",
    green: "#D0E4D8",
    blue: "#D2DCE8",
    gold: "#E8DFC8",
    slate: "#DDE3EA",
  },
  dark: {
    brick: "#6E4842",
    green: "#3D5A4A",
    blue: "#3D4F66",
    gold: "#5C5340",
    slate: "#4A5562",
  },
} as const satisfies Record<"light" | "dark", Record<SpendStackedAreaKey, string>>;

/** Default series order for Spend stacked areas (matches chart stack indices). */
export const SPEND_STACKED_AREA_ORDER: readonly SpendStackedAreaKey[] = [
  "brick",
  "green",
  "blue",
  "gold",
  "slate",
];
