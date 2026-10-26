import type { AdhocDataType, AdhocMapping } from "../api";

function dataTypeLabel(kind: AdhocDataType): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function mappingWarning(mapping: AdhocMapping, layoutKind: string): string | null {
  if (mapping.target === "ignore") return null;
  if (mapping.target === "amount" && mapping.data_type !== "number") {
    return `Amount usually expects Number, not ${dataTypeLabel(mapping.data_type)}.`;
  }
  if (
    (mapping.target === "metric_id" || mapping.target === "version")
    && mapping.data_type !== "text"
  ) {
    return `${mapping.target} usually expects Text, not ${dataTypeLabel(mapping.data_type)}.`;
  }
  if (
    mapping.target === "period"
    && layoutKind !== "account_month_pivot"
    && mapping.data_type !== "date"
    && mapping.data_type !== "datetime"
    && mapping.data_type !== "text"
  ) {
    return `Period usually expects Date, Date & time, or Text, not ${dataTypeLabel(mapping.data_type)}.`;
  }
  return null;
}
