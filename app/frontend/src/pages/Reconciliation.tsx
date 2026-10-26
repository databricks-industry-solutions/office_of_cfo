import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import {
  api, fmt, Account, Adjustment, AdjustmentPosted, AdjustmentType, BusinessUnit, GenieAnswer,
  Persona, ReconBreak, Scope, VarianceExplanation,
} from "../api";
import {
  AdjustmentStatusBadge, Button, Card, ErrorNote, Section, Select, TableSkeleton,
} from "../components/ui";

// The approval policy's type allowlist keys off these; labels are shared across
// industries (the four canonical types in config/vertical_overlays.yaml).
const ADJUSTMENT_TYPE_OPTIONS: { value: AdjustmentType; label: string }[] = [
  { value: "accrual", label: "Accrual" },
  { value: "reclass", label: "Reclass" },
  { value: "intercompany_elimination", label: "Intercompany elimination" },
  { value: "fx_overlay", label: "FX overlay" },
];

export default function Reconciliation({
  scope, persona, onDataChange, refreshKey,
}: {
  scope: Scope;
  persona: Persona | null;
  onDataChange: () => void;
  refreshKey: number;
}) {
  const canPost = !!persona?.can_post;
  const [breaks, setBreaks] = useState<ReconBreak[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [explanations, setExplanations] = useState<VarianceExplanation[]>([]);
  const [modalBreak, setModalBreak] = useState<ReconBreak | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [explainBreak, setExplainBreak] = useState<ReconBreak | null>(null);
  const [posted, setPosted] = useState<AdjustmentPosted | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, a, u, adj, ex] = await Promise.all([
        api.reconBreaks(scope), api.accounts(), api.businessUnits(), api.adjustments(),
        api.varianceExplanations(),
      ]);
      setBreaks(b); setAccounts(a); setBus(u); setAdjustments(adj); setExplanations(ex); setError(null);
    } catch (e: any) {
      setError(e?.message || "Couldn’t load variance data.");
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const openBreaks = breaks.filter((b) => b.is_break === true || b.is_break === "true");

  // Map each break to the furthest-along adjustment posted against it, so a
  // pending/approved entry shows feedback in the row even though the variance
  // won't clear until the adjustment is signed off and flows to the lake.
  const statusRank: Record<string, number> = { pending: 0, approved: 1, signed_off: 2 };
  const adjByBreak = new Map<string, Adjustment["status"]>();
  for (const a of adjustments) {
    if (!a.resolves_break) continue;
    const prev = adjByBreak.get(a.resolves_break);
    if (prev === undefined || statusRank[a.status] > statusRank[prev]) {
      adjByBreak.set(a.resolves_break, a.status);
    }
  }

  // A variance is cleared for close when it is EITHER resolved by a signed-off
  // adjustment OR documented with a written explanation. Explanations are keyed
  // by the same "{control}/{bu}" ref as resolves_break.
  const explByRef = new Map<string, VarianceExplanation>();
  for (const e of explanations) explByRef.set(e.ref, e);
  const unexplained = openBreaks.filter((b) => {
    const ref = `${b.control_account_code}/${b.business_unit_id}`;
    return !adjByBreak.has(ref) && !explByRef.has(ref);
  }).length;

  return (
    <div className="space-y-6">
      {error && <ErrorNote message={error} />}

      {posted && <PostOutcome res={posted} onDismiss={() => setPosted(null)} />}

      <Card
        title="Breaks requiring review"
        action={
          <span className="text-xs text-fg-muted">
            {openBreaks.length} open ·{" "}
            <span className={unexplained > 0 ? "text-signal-bad font-medium" : "text-signal-good font-medium"}>
              {unexplained} unexplained
            </span>
          </span>
        }
      >
        {loading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-fg-muted text-left">
                <tr className="border-b">
                  <th className="px-5 py-2.5 font-medium">Control account</th>
                  <th className="px-5 py-2.5 font-medium">Business unit</th>
                  <th className="px-5 py-2.5 font-medium text-right">Subledger</th>
                  <th className="px-5 py-2.5 font-medium text-right">GL</th>
                  <th className="px-5 py-2.5 font-medium text-right">Variance</th>
                  <th className="px-5 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {breaks.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-fg-muted">No variance rows.</td></tr>
                )}
                {breaks.map((b, i) => {
                  const broken = b.is_break === true || b.is_break === "true";
                  const ref = `${b.control_account_code}/${b.business_unit_id}`;
                  const adjStatus = broken ? adjByBreak.get(ref) : undefined;
                  const expl = broken ? explByRef.get(ref) : undefined;
                  return (
                    <tr key={i} className="border-b last:border-0 record-row-hover">
                      <td className="px-5 py-3">
                        <div className="font-medium">{b.account_name}</div>
                        <div className="text-xs text-fg-muted">{b.control_account_code}</div>
                      </td>
                      <td className="px-5 py-3 text-fg">{b.business_unit_name}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt(b.subledger_total)}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt(b.gl_balance)}</td>
                      <td className={`px-5 py-3 text-right tabular-nums font-medium ${broken ? "text-signal-bad" : "text-signal-good"}`}>
                        {fmt(b.variance)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {broken ? (
                          adjStatus ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <AdjustmentStatusBadge status={adjStatus} />
                              <span className="text-[11px] text-fg-subtle">
                                {adjStatus === "signed_off"
                                  ? "Clears on next recompute"
                                  : "Clears once signed off"}
                              </span>
                            </div>
                          ) : expl ? (
                            <div className="flex flex-col items-end gap-0.5">
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-signal-good bg-signal-good/10 ring-1 ring-signal-good/30 rounded-full px-2 py-0.5">
                                Explained
                              </span>
                              <span className="text-[11px] text-fg-subtle max-w-[16rem] truncate" title={expl.explanation}>
                                {expl.explanation}
                              </span>
                              {canPost && (
                                <button className="text-[11px] text-fg-muted hover:text-fg underline"
                                        onClick={() => setExplainBreak(b)}>
                                  Edit explanation
                                </button>
                              )}
                            </div>
                          ) : canPost ? (
                            <div className="flex items-center justify-end gap-2">
                              <Button variant="outline" size="sm" onClick={() => setExplainBreak(b)}>
                                Explain
                              </Button>
                              <Button variant="primary" size="sm" onClick={() => { setModalBreak(b); setModalOpen(true); }}>
                                Post adjustment
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-fg-subtle">Accountant posts or explains</span>
                          )
                        ) : (
                          <span className="text-xs text-signal-good font-medium">✓ tied</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <RootCauseSection openBreakCount={openBreaks.length} />

      <Section
        key={adjustments.length > 0 ? "adj-has" : "adj-none"}
        title="Posted adjustments"
        count={adjustments.length || undefined}
        defaultOpen={adjustments.length > 0}
        action={
          canPost ? (
            <Button variant="primary" size="sm" onClick={() => { setModalBreak(null); setModalOpen(true); }}>
              + New adjustment
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <TableSkeleton rows={3} cols={6} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-fg-muted text-left">
                <tr className="border-b">
                  <th className="px-5 py-2.5 font-medium">Adjustment</th>
                  <th className="px-5 py-2.5 font-medium">Account</th>
                  <th className="px-5 py-2.5 font-medium">BU</th>
                  <th className="px-5 py-2.5 font-medium">Dr/Cr</th>
                  <th className="px-5 py-2.5 font-medium text-right">Amount</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Memo</th>
                  <th className="px-5 py-2.5 font-medium">Entered by</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-8 text-center text-fg-muted">No adjustments posted yet.</td></tr>
                )}
                {adjustments.map((a, i) => (
                  <tr key={i} className="border-b last:border-0 record-row-hover">
                    <td className="px-5 py-2.5 font-mono text-xs">{a.adjustment_id}</td>
                    <td className="px-5 py-2.5">{a.account_code}</td>
                    <td className="px-5 py-2.5">{a.business_unit_id}</td>
                    <td className="px-5 py-2.5">{a.dr_cr === "D" ? "Debit" : "Credit"}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{fmt(a.amount)}</td>
                    <td className="px-5 py-2.5"><AdjustmentStatusBadge status={a.status} /></td>
                    <td className="px-5 py-2.5 text-fg-muted">{a.memo}</td>
                    <td className="px-5 py-2.5 text-fg-muted">{a.posted_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {modalOpen && (
        <AdjustmentModal
          accounts={accounts}
          bus={bus}
          seed={modalBreak}
          onClose={() => setModalOpen(false)}
          onPosted={async (res) => {
            setModalOpen(false); setPosted(res); await refresh(); onDataChange();
          }}
        />
      )}

      {explainBreak && (
        <ExplainModal
          seed={explainBreak}
          existing={explByRef.get(`${explainBreak.control_account_code}/${explainBreak.business_unit_id}`)?.explanation ?? ""}
          onClose={() => setExplainBreak(null)}
          onSaved={async () => { setExplainBreak(null); await refresh(); onDataChange(); }}
        />
      )}
    </div>
  );
}

function ExplainModal({
  seed, existing, onClose, onSaved,
}: {
  seed: ReconBreak;
  existing: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [explanation, setExplanation] = useState(existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    textRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previouslyFocused?.focus?.(); };
  }, [onClose]);

  const submit = async () => {
    setBusy(true); setError("");
    try {
      await api.explainVariance({
        control_account_code: seed.control_account_code,
        business_unit_id: seed.business_unit_id,
        explanation,
      });
      onSaved();
    } catch (e: any) {
      setError(e.message); setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="explain-modal-title"
        className="bg-ink-800 rounded-xl shadow-depth ring-1 ring-line w-full max-w-lg"
      >
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h3 id="explain-modal-title" className="text-base font-semibold text-fg">Explain variance</h3>
          <button onClick={onClose} aria-label="Close dialog" className="text-fg-muted hover:text-fg rounded p-1 leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="text-sm bg-signal-warn/10 text-signal-warn rounded-md px-3 py-2 border border-signal-warn/30">
            {seed.account_name} in {seed.business_unit_name}: variance {fmt(seed.variance)}
          </div>
          <p className="text-xs text-fg-muted">
            Document why this variance is acceptable to clear it for close. Explaining does not post a
            journal entry — the variance stays open on the ledger but is no longer a close blocker.
          </p>
          <Field label="Explanation">
            <textarea
              ref={textRef}
              className="w-full border border-line rounded-md px-3 py-2 text-sm min-h-[96px]"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="e.g. Timing difference — subledger invoices post in the next period; immaterial to the close."
            />
          </Field>
          {error && <div role="alert" className="text-sm text-signal-bad">{error}</div>}
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <Button variant="outline" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={busy || !explanation.trim()}>
            {busy ? "Saving…" : "Save explanation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** What the policy did with the entry that was just posted — shown to the poster
 *  immediately, so automation is never silent. */
function PostOutcome({ res, onDismiss }: { res: AdjustmentPosted; onDismiss: () => void }) {
  const auto = res.approval_mode === "auto";
  const tone = auto
    ? "bg-signal-good/10 text-signal-good ring-signal-good/30"
    : "bg-signal-warn/10 text-signal-warn ring-signal-warn/30";
  return (
    <div className={`text-sm rounded-lg px-4 py-3 ring-1 ${tone}`} role="status">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="font-medium">
            {auto
              ? `Auto-approved and signed off under ${res.policy_name} v${res.policy_version}.`
              : "Routed to review — a human needs to approve this one."}
          </span>
          <span className="block text-xs mt-0.5 opacity-90">
            {auto
              ? "It is already in the ledger and on the auto-approval register."
              : res.reasons.join(" · ")}
          </span>
        </div>
        <button onClick={onDismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100 leading-none">✕</button>
      </div>
    </div>
  );
}

function AdjustmentModal({
  accounts, bus, seed, onClose, onPosted,
}: {
  accounts: Account[];
  bus: BusinessUnit[];
  seed: ReconBreak | null;
  onClose: () => void;
  onPosted: (res: AdjustmentPosted) => void;
}) {
  const [debit, setDebit] = useState(seed ? "50000" : accounts[0]?.account_code ?? "");
  const [credit, setCredit] = useState(seed?.control_account_code ?? accounts[1]?.account_code ?? "");
  const [bu, setBu] = useState(seed?.business_unit_id ?? bus[0]?.business_unit_id ?? "");
  const [amount, setAmount] = useState(seed ? Math.abs(parseFloat(seed.variance)).toFixed(2) : "");
  const [memo, setMemo] = useState(
    seed ? `Catch-up posting for delayed ${seed.account_name} invoices (timing variance)` : "");
  const [adjType, setAdjType] = useState<AdjustmentType>("accrual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const sameAccount = debit === credit;

  // Focus the first field on open; restore focus to the trigger on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Escape to close + simple focus trap so Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const res = await api.postAdjustment({
        debit_account: debit, credit_account: credit, business_unit_id: bu,
        amount: parseFloat(amount), memo, adjustment_type: adjType,
        resolves_break: seed ? `${seed.control_account_code}/${seed.business_unit_id}` : null,
      });
      onPosted(res);
    } catch (e: any) {
      setError(e.message); setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="adjustment-modal-title"
        className="bg-ink-800 rounded-xl shadow-depth ring-1 ring-line w-full max-w-lg"
      >
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h3 id="adjustment-modal-title" className="text-base font-semibold text-fg">
            {seed ? "Post correcting journal adjustment" : "New journal adjustment"}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="text-fg-muted hover:text-fg rounded p-1 leading-none"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {seed && (
            <div className="text-sm bg-signal-warn/10 text-signal-warn rounded-md px-3 py-2 border border-signal-warn/30">
              Resolving {seed.account_name} variance in {seed.business_unit_name}: {fmt(seed.variance)}
            </div>
          )}
          <Field label="Debit account">
            <AccountSelect ref={firstFieldRef} accounts={accounts} value={debit} onChange={setDebit} />
          </Field>
          <Field label="Credit account">
            <AccountSelect accounts={accounts} value={credit} onChange={setCredit} />
          </Field>
          {sameAccount && (
            <div className="text-xs text-signal-warn">Debit and credit accounts are the same — pick two different accounts.</div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Business unit">
              <Select
                aria-label="Business unit"
                fullWidth
                value={bu}
                onChange={setBu}
                options={bus.map((u) => ({ value: u.business_unit_id, label: u.business_unit_name }))}
              />
            </Field>
            <Field label="Amount (USD)">
              <input type="number" step="0.01" className="w-full border border-line rounded-md px-3 py-2 text-sm"
                     value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label="Adjustment type">
            <Select
              aria-label="Adjustment type"
              fullWidth
              value={adjType}
              onChange={(v) => setAdjType(v as AdjustmentType)}
              options={ADJUSTMENT_TYPE_OPTIONS}
            />
          </Field>
          <Field label="Memo">
            <input className="w-full border border-line rounded-md px-3 py-2 text-sm" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
          {error && <div role="alert" className="text-sm text-signal-bad">{error}</div>}
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <Button variant="outline" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit}
                  disabled={busy || !amount || parseFloat(amount) <= 0 || sameAccount}>
            {busy ? "Posting…" : "Post adjustment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const AccountSelect = forwardRef<HTMLButtonElement, { accounts: Account[]; value: string; onChange: (v: string) => void }>(
  function AccountSelect({ accounts, value, onChange }, ref) {
    return (
      <Select
        ref={ref}
        aria-label="Account"
        fullWidth
        value={value}
        onChange={onChange}
        options={accounts.map((a) => ({ value: a.account_code, label: `${a.account_code} · ${a.account_name}` }))}
      />
    );
  }
);

// Root-cause analysis of the close's open breaks, answered on demand by the
// dedicated investigation Genie space (POST /genie/investigate). The controller
// clicks the button; we render Genie's narrative plus the per-invoice breakdown
// table (which invoice, which reason, how much) so the "why" behind each break
// is visible right on the reconciliation page.
function RootCauseSection({ openBreakCount }: { openBreakCount: number }) {
  const [answer, setAnswer] = useState<GenieAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.genieInvestigate());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn’t analyze root causes.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Section
      title="Reconciliation analysis — the reason behind the breaks"
      subtitle="AI investigation of what’s driving each open break"
      tone="quiet"
      collapsible={false}
      action={
        <Button variant="primary" size="sm" onClick={analyze} disabled={busy}>
          {busy ? "Analyzing…" : answer ? "Re-run analysis" : "Analyze root causes"}
        </Button>
      }
    >
      <div className="px-5 py-4 space-y-3">
        {!answer && !busy && !error && (
          <p className="text-sm text-fg-muted">
            {openBreakCount > 0
              ? `Decompose the ${openBreakCount} open break${openBreakCount === 1 ? "" : "s"} into root causes — timing, unposted credit notes, FX, discounts, posting errors — with the specific invoices behind each.`
              : "No open breaks this close. Run the analysis to confirm the reconciliation is clean."}
          </p>
        )}
        {busy && <p className="text-sm text-fg-muted">Asking Genie to investigate the open breaks…</p>}
        {error && <ErrorNote message={error} />}
        {answer?.text && (
          <div className="text-sm text-fg-muted whitespace-pre-wrap leading-relaxed">
            {answer.text}
          </div>
        )}
        {answer?.table && answer.table.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg ring-1 ring-line">
            <table className="w-full text-[12px] border-collapse">
              <thead>
                <tr className="bg-black/[0.03]">
                  {answer.table.columns.map((c) => (
                    <th key={c} className="px-3 py-2 text-left font-medium text-fg-muted whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {answer.table.rows.slice(0, 100).map((r, i) => (
                  <tr key={i} className="border-t border-line/60">
                    {r.map((cell, j) => (
                      <td key={j} className="px-3 py-2 text-fg-muted whitespace-nowrap tabular-nums">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {answer?.query && (
          <details className="text-xs text-fg-subtle">
            <summary className="cursor-pointer">Show the SQL Genie ran</summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-800 ring-1 ring-line p-3 font-mono text-[11px]">{answer.query}</pre>
          </details>
        )}
      </div>
    </Section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-fg-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
