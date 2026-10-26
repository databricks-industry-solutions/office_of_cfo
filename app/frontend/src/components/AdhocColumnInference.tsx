import type { ReactNode } from "react";
import type { AdhocDataType, AdhocMapping, AdhocMappingTarget } from "../api";
import { mappingWarning } from "../lib/adhocMapping";

const DATA_TYPE_OPTIONS: { id: AdhocDataType; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "number", label: "Number" },
  { id: "date", label: "Date" },
  { id: "datetime", label: "Date & time" },
  { id: "time", label: "Time" },
  { id: "boolean", label: "Boolean" },
];

const ROLE_OPTIONS: { id: AdhocMappingTarget; label: string }[] = [
  { id: "metric_id", label: "Metric" },
  { id: "period", label: "Period" },
  { id: "amount", label: "Amount" },
  { id: "version", label: "Version" },
  { id: "ignore", label: "Ignore" },
];

function scoreLabel(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}% confidence`;
}

export function AdhocInferenceStrip({ children }: { children: ReactNode }) {
  return (
    <div
      aria-label="Column inferences"
      className="mt-2 flex w-full min-w-0 max-w-full flex-nowrap gap-2 overflow-x-auto pb-1"
    >
      {children}
    </div>
  );
}

export function AdhocColumnInference({
  mapping,
  layoutKind,
  sampleValues,
  onChange,
}: {
  mapping: AdhocMapping;
  layoutKind: string;
  sampleValues: string[];
  onChange(next: AdhocMapping): void;
}) {
  const warning = mappingWarning(mapping, layoutKind);
  const controlId = mapping.source.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const showConfirmed = mapping.user_confirmed_data_type || mapping.user_confirmed_role;
  return (
    <div className="min-w-[10rem] flex-none rounded-xl bg-black/[0.025] px-3 py-2 ring-1 ring-line lg:flex-1">
      <div className="text-xs font-medium text-fg">{mapping.source}</div>
      {sampleValues.length > 0 && (
        <div className="mt-1 text-[11px] text-fg-subtle truncate">
          {sampleValues.join(" · ")}
        </div>
      )}

      <div className="mt-2">
        <div className="flex items-center justify-between gap-1">
          <label htmlFor={`${controlId}-type`} className="text-[11px] font-medium text-fg-subtle">
            Data type
          </label>
          <span className="truncate text-[10px] text-fg-subtle">
            {scoreLabel(mapping.data_type_confidence)}
          </span>
        </div>
        <select
          id={`${controlId}-type`}
          aria-label={`Data type for ${mapping.source}`}
          className="mt-0.5 w-full border border-line rounded-md px-2 py-1 text-xs bg-transparent"
          value={mapping.data_type}
          onChange={(event) => {
            onChange({
              ...mapping,
              data_type: event.target.value as AdhocDataType,
              data_type_confidence: 1,
              user_confirmed_data_type: true,
            });
          }}
        >
          {DATA_TYPE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </div>

      <div className="mt-2">
        <div className="flex items-center justify-between gap-1">
          <label htmlFor={`${controlId}-role`} className="text-[11px] font-medium text-fg-subtle">
            Use as
          </label>
          <span className="truncate text-[10px] text-fg-subtle">
            {scoreLabel(mapping.role_confidence)}
          </span>
        </div>
        <select
          id={`${controlId}-role`}
          aria-label={`Use ${mapping.source} as`}
          className="mt-0.5 w-full border border-line rounded-md px-2 py-1 text-xs bg-transparent"
          value={mapping.target}
          onChange={(event) => {
            onChange({
              ...mapping,
              target: event.target.value as AdhocMappingTarget,
              role_confidence: 1,
              user_confirmed_role: true,
            });
          }}
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </div>

      {showConfirmed && (
        <div className="mt-1 text-[11px] font-medium text-brick-500">Confirmed by you</div>
      )}
      {warning && (
        <div className="mt-1 text-[11px] text-signal-warn">{warning}</div>
      )}
    </div>
  );
}
