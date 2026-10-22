export const SPEND_GROUP_OPTIONS = [
  { value: "use_case", label: "Use case" },
  { value: "org_unit", label: "Org unit" },
  { value: "model", label: "Model" },
  { value: "environment", label: "Environment" },
] as const;

export type SpendGroupBy = (typeof SPEND_GROUP_OPTIONS)[number]["value"];

export function spendGroupLabel(groupBy: string): string {
  return SPEND_GROUP_OPTIONS.find((g) => g.value === groupBy)?.label
    ?? groupBy.replace(/_/g, " ");
}

export function prettifyTrendGroup(key: string): string {
  if (key.startsWith("m-")) return key.slice(2);
  const seg = key.split("-").pop() ?? key;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
