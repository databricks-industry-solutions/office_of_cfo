import { AlertTriangle, ShieldCheck } from "lucide-react";
import { AiRoiAttributionPolicy } from "../../../api";
import { Card } from "../../ui";

export function AttributionPolicyCard({
  policy,
  hasRevenueValue,
}: {
  policy: AiRoiAttributionPolicy | null;
  hasRevenueValue: boolean;
}) {
  if (!hasRevenueValue) return null;

  if (!policy) {
    return (
      <Card title="Attribution policy missing" className="ring-signal-warn/40">
        <div data-testid="ai-roi-policy" className="flex items-start gap-2 p-5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-warn" />
          <p>This use case reports attributed value but has no signed attribution policy. The value claim is unbacked until a policy with a named owner is attached.</p>
        </div>
      </Card>
    );
  }

  const overdue = policy.review_due_on ? new Date(policy.review_due_on) < new Date() : false;
  return (
    <Card
      title={policy.policy_name}
      action={<ShieldCheck className="h-4 w-4 text-signal-good" aria-hidden />}
    >
      <div data-testid="ai-roi-policy" className="space-y-3 p-5 text-sm">
        <p className="text-fg">“{policy.rule}”</p>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-fg-subtle uppercase tracking-wide">Owner</dt><dd className="mt-0.5 capitalize">{policy.owner_role}</dd></div>
          <div><dt className="text-fg-subtle uppercase tracking-wide">Method</dt><dd className="mt-0.5 capitalize">{policy.method.replace(/_/g, " ")}</dd></div>
          <div><dt className="text-fg-subtle uppercase tracking-wide">Signed off</dt><dd className="mt-0.5">{policy.signed_off_on ?? "—"}</dd></div>
          <div><dt className="text-fg-subtle uppercase tracking-wide">Review due</dt><dd className={`mt-0.5 ${overdue ? "text-signal-warn" : ""}`}>{policy.review_due_on ?? "—"}</dd></div>
        </dl>
        {overdue && <p className="text-xs text-signal-warn">Policy review is overdue.</p>}
      </div>
    </Card>
  );
}
