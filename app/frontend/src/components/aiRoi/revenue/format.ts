import { fmtCompact } from "../../../api";

export const money = fmtCompact;

export function ratio(v: number | null | undefined) {
  return v == null ? "—" : `${v.toFixed(2)}×`;
}

export function pctShare(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export function monthsLabel(v: number | null | undefined) {
  return v == null ? "—" : `${v.toFixed(1)} mo`;
}

export function unitPrice(v: number | null | undefined) {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}
