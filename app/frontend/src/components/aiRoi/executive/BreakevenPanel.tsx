import { ArrowRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AiRoiExecutive, Scope, api } from "../../../api";
import { PageId } from "../../../nav";
import { Card, MultiSelect } from "../../ui";
import { BreakevenChart } from "../charts";
import { useAiRoiLoad } from "../shared";

export function ExecutiveBreakevenPanel({
  data,
  scope,
  onNavigate,
  showRoiLink = true,
}: {
  data: AiRoiExecutive;
  scope: Scope;
  onNavigate: (page: PageId, query?: string) => void;
  showRoiLink?: boolean;
}) {
  const available = data.markets ?? [];
  const [selected, setSelected] = useState<string[]>(available);
  useEffect(() => {
    if (available.length && selected.length === 0) setSelected(available);
  }, [available, selected.length]);

  const marketsParam = useMemo(() => {
    if (!available.length || selected.length === available.length) return undefined;
    return selected;
  }, [available.length, selected]);

  const fetched = useAiRoiLoad(
    () => api.aiRoiBreakeven(scope, marketsParam),
    [scope, marketsParam?.join(",") ?? "all"],
  );
  const breakeven = fetched.data ?? data.breakeven;
  const scopeLabel = scope.scope_type === "consolidated" ? "Enterprise" : scope.scope_id;

  return (
    <Card
      title={`Break-even — ${scopeLabel}`}
      action={
        <div className="flex items-center gap-3">
          {available.length > 0 && (
            <MultiSelect
              aria-label="Filter by region"
              size="sm"
              allLabel="All regions"
              values={selected}
              options={available.map((market) => ({ value: market, label: market }))}
              onChange={setSelected}
            />
          )}
          {showRoiLink && (
            <button
              type="button"
              onClick={() => onNavigate("ai-roi-roi")}
              className="inline-flex items-center gap-1 text-xs text-brick hover:underline"
            >
              Full ROI view <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      }
      className="h-full"
    >
      <div data-testid="ai-roi-breakeven" className="p-5">
        <BreakevenChart
          months={breakeven?.months ?? []}
          crossover={breakeven?.crossover_month}
          lastActualIndex={breakeven?.last_actual_index}
          bandLow={breakeven?.band_low}
          bandHigh={breakeven?.band_high}
        />
      </div>
    </Card>
  );
}
