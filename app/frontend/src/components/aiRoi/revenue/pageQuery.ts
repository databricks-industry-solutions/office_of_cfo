import { AiRoiDimension } from "../../../api";

export function mergePageQuery(base: string, patch: Record<string, string | null | undefined>) {
  const params = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

export function revenueDimensionFromQuery(hashQuery: string, fallback: AiRoiDimension): AiRoiDimension {
  const dim = new URLSearchParams(hashQuery).get("dim");
  if (dim === "business_unit" || dim === "use_case" || dim === "market") return dim;
  return fallback;
}

export function useCaseFromQuery(hashQuery: string): string | null {
  return new URLSearchParams(hashQuery).get("useCase");
}
