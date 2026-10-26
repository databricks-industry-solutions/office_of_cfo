import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, fmt, ApprovalPolicy, ApprovalPolicyVersion, Persona, PolicySimulation,
} from "../api";
import { Button, Card, ErrorNote, Section, TableSkeleton } from "./ui";

/** Rule presentation: label, help text, and which parameters the editor exposes.
 *  The rule set itself is fixed in the backend (`server/policy.py`); this only
 *  describes how to render it, so a rule can never be invented in the UI. */
const RULE_META: Record<string, {
  label: string;
  help: string;
  params: { key: string; label: string; kind: "money" | "int" | "pct" | "list" }[];
}> = {
  amount_limit: {
    label: "Amount limit",
    help: "Auto-approve only entries at or below this amount.",
    params: [{ key: "max_amount", label: "Maximum amount", kind: "money" }],
  },
  account_policy: {
    label: "Restricted accounts",
    help: "Never auto-approve an entry touching these account types or codes.",
    params: [
      { key: "restricted_account_types", label: "Account types", kind: "list" },
      { key: "restricted_accounts", label: "Account codes", kind: "list" },
    ],
  },
  type_allowlist: {
    label: "Adjustment type",
    help: "Only these adjustment types may auto-approve.",
    params: [{ key: "allowed_types", label: "Allowed types", kind: "list" }],
  },
  break_backed: {
    label: "Break-backed",
    help: "Require the entry to clear an identified reconciliation break, within tolerance.",
    params: [{ key: "tolerance_pct", label: "Tolerance %", kind: "pct" }],
  },
  memo_required: {
    label: "Memo required",
    help: "Require a memo long enough to read a year from now.",
    params: [{ key: "min_chars", label: "Minimum characters", kind: "int" }],
  },
  period_window: {
    label: "Close window",
    help: "Close automation after this business day, protecting the last mile.",
    params: [{ key: "max_bd", label: "Last business day", kind: "int" }],
  },
  cumulative_cap: {
    label: "Cumulative cap",
    help: "Cap the total value auto-approved per business unit each period.",
    params: [{ key: "max_total", label: "Maximum total", kind: "money" }],
  },
};

const RULE_ORDER = Object.keys(RULE_META);

function fmtWhen(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-signal-good/10 text-signal-good border-signal-good/30",
  draft: "bg-signal-warn/10 text-signal-warn border-signal-warn/30",
  retired: "bg-black/[0.04] text-fg-muted border-line",
};

export default function ApprovalPolicyCard({
  persona, refreshKey, onDataChange,
}: {
  persona: Persona | null;
  refreshKey: number;
  onDataChange: () => void;
}) {
  const [draft, setDraft] = useState<ApprovalPolicy | null>(null);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [closeBd, setCloseBd] = useState<number>(0);
  const [versions, setVersions] = useState<ApprovalPolicyVersion[]>([]);
  const [sim, setSim] = useState<PolicySimulation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const canAuthor = !!persona?.can_approve;
  const canAttest = !!persona?.can_sign_off;

  const refresh = useCallback(async () => {
    try {
      const [state, history] = await Promise.all([
        api.approvalPolicy(), api.approvalPolicyVersions(),
      ]);
      setDraft(state.active);
      setActiveVersion(state.version);
      setCloseBd(state.close_bd);
      setVersions(history);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Couldn’t load the approval policy.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const pendingDraft = useMemo(
    () => versions.find((v) => v.status === "draft") ?? null, [versions]);

  const patchRule = (ruleId: string, changes: Record<string, unknown>) => {
    setDraft((p) => p && ({
      ...p, rules: { ...p.rules, [ruleId]: { ...p.rules[ruleId], ...changes } },
    }));
    setSim(null);
    setNote(null);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null); setNote(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const simulate = () => draft && run("simulate", async () => {
    setSim(await api.simulateApprovalPolicy(draft));
  });

  const saveDraft = () => draft && run("draft", async () => {
    const res = await api.draftApprovalPolicy(draft);
    setNote(`Saved as draft v${res.version}. The CFO attests to activate it.`);
    await refresh();
    onDataChange();
  });

  const attest = (version: number) => run("attest", async () => {
    await api.attestApprovalPolicy(version);
    setNote(`Policy v${version} attested and active.`);
    setSim(null);
    await refresh();
    onDataChange();
  });

  if (loading) {
    return <Card title="Approval policy" className="lg:col-span-2"><TableSkeleton rows={5} cols={2} /></Card>;
  }

  if (!draft) {
    return (
      <Card title="Approval policy" className="lg:col-span-2">
        <div className="px-5 py-6 text-sm text-fg-muted">
          {error ?? "No approval policy is active, so every adjustment goes to a human."}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Approval policy"
      className="lg:col-span-2"
      action={
        <div className="flex items-center gap-2">
          {activeVersion && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium border bg-signal-good/10 text-signal-good border-signal-good/30">
              v{activeVersion} active
            </span>
          )}
          {canAuthor && (
            <>
              <Button variant="outline" size="sm" onClick={simulate} disabled={busy !== null}>
                {busy === "simulate" ? "Simulating…" : "Simulate"}
              </Button>
              <Button variant="primary" size="sm" onClick={saveDraft} disabled={busy !== null}>
                {busy === "draft" ? "Saving…" : "Save as draft"}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="px-5 py-4 space-y-4">
        {error && <ErrorNote message={error} />}
        {note && <div className="text-sm text-signal-good">{note}</div>}

        <label className="block">
          <span className="text-xs text-fg-muted">Policy name</span>
          <input
            value={draft.name}
            disabled={!canAuthor}
            onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setSim(null); setNote(null); }}
            className="mt-1 w-full border border-line rounded-md px-3 py-2 text-sm font-medium"
          />
        </label>

        <p className="text-xs text-fg-subtle">
          Adjustments satisfying every enabled rule are approved and signed off automatically;
          anything that breaks a rule goes to a human with the reason named. The Controller
          authors the policy, the CFO attests to it — that is where the four-eyes control now
          sits. Today is business day {closeBd} of the close.
        </p>

        <label className="flex items-center justify-between gap-3 text-sm py-2 border-y">
          <span className="text-fg font-medium">
            Auto-approval enabled
            <span className="block text-xs text-fg-subtle font-normal">
              Switch off to send every adjustment through the human queue.
            </span>
          </span>
          <input type="checkbox" checked={draft.auto_approval_enabled} disabled={!canAuthor}
                 onChange={(e) => {
                   setDraft({ ...draft, auto_approval_enabled: e.target.checked });
                   setSim(null); setNote(null);
                 }} />
        </label>

        <div className="space-y-3">
          {RULE_ORDER.map((ruleId) => {
            const meta = RULE_META[ruleId];
            const rule = draft.rules[ruleId] ?? { enabled: false };
            return (
              <div key={ruleId} className="rounded-lg ring-1 ring-line px-3.5 py-3">
                <label className="flex items-start justify-between gap-3 text-sm">
                  <span className="text-fg font-medium">
                    {meta.label}
                    <span className="block text-xs text-fg-subtle font-normal mt-0.5">{meta.help}</span>
                  </span>
                  <input type="checkbox" checked={!!rule.enabled} disabled={!canAuthor}
                         className="mt-1"
                         onChange={(e) => patchRule(ruleId, { enabled: e.target.checked })} />
                </label>
                {rule.enabled && (
                  <div className="mt-2.5 flex flex-wrap gap-3">
                    {meta.params.map((p) => (
                      <RuleParam
                        key={p.key}
                        label={p.label}
                        kind={p.kind}
                        value={rule[p.key]}
                        disabled={!canAuthor}
                        onChange={(v) => patchRule(ruleId, { [p.key]: v })}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {sim && <Simulation sim={sim} />}

        {pendingDraft && (
          <div className="rounded-lg ring-1 ring-signal-warn/30 bg-signal-warn/[0.06] px-3.5 py-3">
            <div className="text-sm font-medium text-fg">
              Draft v{pendingDraft.version} awaiting attestation
            </div>
            <div className="text-xs text-fg-muted mt-0.5">
              Authored by {pendingDraft.authored_by ?? "—"} · {fmtWhen(pendingDraft.authored_ts)}
            </div>
            <ul className="mt-2 space-y-0.5">
              {pendingDraft.diff.map((d, i) => (
                <li key={i} className="text-xs text-fg-muted">• {d}</li>
              ))}
            </ul>
            <div className="mt-2.5">
              {canAttest ? (
                <Button variant="primary" size="sm" disabled={busy !== null}
                        onClick={() => attest(pendingDraft.version)}>
                  {busy === "attest" ? "Attesting…" : "Attest & activate"}
                </Button>
              ) : (
                <span className="text-xs text-fg-subtle">
                  Awaiting CFO attestation — the author cannot activate their own policy.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <Section title="Version history" count={versions.length || undefined} defaultOpen={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-fg-muted text-left">
              <tr className="border-b">
                <th className="px-5 py-2.5 font-medium">Version</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 font-medium">Authored</th>
                <th className="px-5 py-2.5 font-medium">Attested</th>
                <th className="px-5 py-2.5 font-medium">Changes</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version} className="border-b last:border-0 align-top">
                  <td className="px-5 py-2.5 font-mono text-xs">v{v.version}</td>
                  <td className="px-5 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${STATUS_TONE[v.status] ?? ""}`}>
                      {v.status}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-xs text-fg-muted">
                    {v.authored_by ?? "—"}<br />{fmtWhen(v.authored_ts)}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-fg-muted">
                    {v.attested_by ?? "—"}<br />{fmtWhen(v.attested_ts)}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-fg-muted">
                    {v.diff.map((d, i) => <div key={i}>{d}</div>)}
                  </td>
                </tr>
              ))}
              {versions.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-6 text-center text-fg-subtle text-sm">
                  No versions recorded yet.
                </td></tr>
              )}
            </tbody>
          </table>
          <p className="px-5 py-3 text-xs text-fg-subtle">
            Versions are append-only: editing mints a new one and retires its predecessor,
            so a retired policy stays readable forever.
          </p>
        </div>
      </Section>
    </Card>
  );
}

function RuleParam({
  label, kind, value, disabled, onChange,
}: {
  label: string;
  kind: "money" | "int" | "pct" | "list";
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  if (kind === "list") {
    const items = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <label className="text-xs text-fg-muted">
        <span className="block mb-1">{label}</span>
        <input
          value={items.join(", ")}
          disabled={disabled}
          onChange={(e) => onChange(
            e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          className="border border-line rounded-md px-2.5 py-1.5 text-sm w-[30rem] max-w-full"
          placeholder="Comma separated"
        />
      </label>
    );
  }
  const num = typeof value === "number" ? value : Number(value ?? 0);
  return (
    <label className="text-xs text-fg-muted">
      <span className="block mb-1">{label}</span>
      <input
        type="number"
        value={Number.isFinite(num) ? num : 0}
        min={0}
        step={kind === "money" ? 500 : kind === "pct" ? 0.5 : 1}
        disabled={disabled}
        onChange={(e) => onChange(
          kind === "int" ? parseInt(e.target.value || "0", 10) : parseFloat(e.target.value || "0"))}
        className="border border-line rounded-md px-2.5 py-1.5 text-sm w-36 text-right num"
      />
    </label>
  );
}

/** Nobody should activate a policy they have not seen scored. */
function Simulation({ sim }: { sim: PolicySimulation }) {
  const review = sim.results.filter((r) => r.mode === "manual");
  return (
    <div className="rounded-lg ring-1 ring-line bg-black/[0.02] px-3.5 py-3">
      <div className="text-sm font-medium text-fg">
        {sim.auto_approved} of {sim.evaluated} entries this period would auto-approve
        {sim.evaluated > 0 && <span className="text-fg-muted"> ({sim.auto_share_pct}%)</span>}
      </div>
      <div className="text-xs text-fg-muted mt-1">
        {fmt(sim.auto_value)} of {fmt(sim.total_value)} by value ({sim.auto_value_share_pct}%) ·
        {" "}{sim.routed_to_review} would come to a human
      </div>
      {review.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {review.map((r) => (
            <li key={r.adjustment_id} className="text-xs">
              <span className="font-mono text-fg-muted">{r.adjustment_id}</span>
              <span className="text-fg-muted"> · {fmt(r.amount)} · {r.business_unit_id}</span>
              <div className="text-signal-warn">{r.reasons.join("; ")}</div>
            </li>
          ))}
        </ul>
      )}
      {sim.evaluated === 0 && (
        <div className="text-xs text-fg-subtle mt-1">
          No adjustments posted this period yet, so there is nothing to score.
        </div>
      )}
    </div>
  );
}
