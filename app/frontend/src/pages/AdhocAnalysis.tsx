import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileSpreadsheet, Sparkles, Upload } from "lucide-react";
import { AdhocMapping, AdhocSamplePack, api, fmtCompact, Scope } from "../api";
import { AdhocColumnInference, AdhocInferenceStrip } from "../components/AdhocColumnInference";
import { Button, Card, CardSkeleton, ErrorNote, KpiSkeletonGrid, Skeleton, SkeletonRegion } from "../components/ui";
import { useOverlay } from "../lib/industry";
import { adhocLineLabel, narrativeBullets } from "../lib/adhocAnalysis";
import { MAX_ADHOC_FILE_BYTES, parseWorkbook, ParsedWorkbook } from "../lib/adhocWorkbook";

type PreviewState = {
  analysisId: string;
  buffer: ArrayBuffer;
  workbook: ParsedWorkbook;
  mappings: AdhocMapping[];
  layoutKind: string;
};

export default function AdhocAnalysis({
  scope,
  period,
  refreshKey,
}: {
  scope: Scope;
  period: string;
  refreshKey: number;
}) {
  const ov = useOverlay();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pack, setPack] = useState<AdhocSamplePack | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPack(null);
    setPreview(null);
    setError(null);
  }, [scope, period, refreshKey]);

  const visibleLines = useMemo(
    () => (pack?.lines ?? []).filter(
      (line) => !(ov.hiddenStatementLines ?? []).includes(line.line_id),
    ),
    [pack, ov.hiddenStatementLines],
  );
  const maxAmount = Math.max(
    1,
    ...visibleLines.flatMap((line) => [Math.abs(line.actual), Math.abs(line.uploaded)]),
  );
  const bullets = pack
    ? narrativeBullets(
      visibleLines,
      pack.summary.total_rows,
      pack.summary.unmapped_amount,
      ov,
    )
    : [];
  const sampleValuesBySource = useMemo(() => {
    if (!preview) return {} as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const mapping of preview.mappings) {
      const index = preview.workbook.headers.indexOf(mapping.source);
      if (index < 0) {
        out[mapping.source] = [];
        continue;
      }
      const seen = new Set<string>();
      const sampleValues: string[] = [];
      for (const row of preview.workbook.previewRows) {
        const value = String(row[index] ?? "").trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        sampleValues.push(value);
        if (sampleValues.length >= 3) break;
      }
      out[mapping.source] = sampleValues;
    }
    return out;
  }, [preview]);

  function clearAnalysis() {
    setPack(null);
    setPreview(null);
    setError(null);
  }

  async function loadSample() {
    setLoading("Preparing sample workbook analysis…");
    setError(null);
    setPreview(null);
    try {
      setPack(await api.adhocSample(scope, period));
    } catch {
      setError("Could not load the sample workbook analysis.");
    } finally {
      setLoading(null);
    }
  }

  async function ingestWorkbook(buffer: ArrayBuffer, filename: string, sheet?: string) {
    const workbook = parseWorkbook(buffer, filename, sheet);
    const parsed = await api.adhocParse({
      analysis_id: preview?.analysisId ?? crypto.randomUUID(),
      filename: workbook.filename,
      sheet: workbook.selectedSheet,
      headers: workbook.headers,
      sample_rows: workbook.previewRows,
      row_count: workbook.rows.length,
    });
    setPack(null);
    setPreview({
      analysisId: parsed.analysis_id,
      buffer,
      workbook,
      mappings: parsed.mappings,
      layoutKind: parsed.layout_kind,
    });
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_ADHOC_FILE_BYTES) {
      setError("Workbooks are limited to 15 MB.");
      return;
    }
    setLoading("Reading workbook…");
    setError(null);
    try {
      await ingestWorkbook(await file.arrayBuffer(), file.name);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "Could not read the workbook.");
    } finally {
      setLoading(null);
    }
  }

  async function onSheetChange(sheet: string) {
    if (!preview) return;
    setLoading("Reading sheet…");
    setError(null);
    try {
      await ingestWorkbook(preview.buffer, preview.workbook.filename, sheet);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that sheet.");
    } finally {
      setLoading(null);
    }
  }

  async function runAnalysis() {
    if (!preview) return;
    setLoading("Comparing to governed books…");
    setError(null);
    try {
      setPack(await api.adhocRun({
        analysis_id: preview.analysisId,
        filename: preview.workbook.filename,
        sheet: preview.workbook.selectedSheet,
        headers: preview.workbook.headers,
        rows: preview.workbook.rows,
        mappings: preview.mappings,
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        period,
      }));
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze the workbook.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-5">
      {(pack || preview) && (
        <div className="flex justify-end">
          <Button variant="neutral" onClick={clearAnalysis}>
            Clear analysis
          </Button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={onFile}
      />

      {error && <ErrorNote message={error} />}
      {loading ? (
        <SkeletonRegion label={loading} className="space-y-5">
          <div className="tile ring-1 ring-line p-5">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 rounded-xl shrink-0" />
              <div className="space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-2.5 w-64" /></div>
              <Skeleton className="ml-auto h-6 w-24 rounded-full" />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
            </div>
          </div>
          <KpiSkeletonGrid count={3} className="grid gap-4 sm:grid-cols-3" tileHeight="h-[104px]" />
          <CardSkeleton>
            <div className="divide-y divide-line" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="grid gap-3 px-5 py-4 md:grid-cols-[12rem_1fr_7rem] md:items-center">
                  <div className="space-y-1.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-24" /></div>
                  <div className="space-y-2"><Skeleton className="h-2 w-4/5 rounded-full" /><Skeleton className="h-2 w-3/5 rounded-full" /></div>
                  <div className="flex flex-col items-end gap-1.5"><Skeleton className="h-3.5 w-14" /><Skeleton className="h-2.5 w-10" /></div>
                </div>
              ))}
            </div>
          </CardSkeleton>
        </SkeletonRegion>
      ) : pack ? (
        <>
          <Card className="p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-brick/10 shrink-0">
                  <FileSpreadsheet className="h-5 w-5 text-brick-500" />
                </div>
                <div>
                  <div className="font-semibold text-fg">{pack.source.filename}</div>
                  <div className="mt-0.5 text-xs text-fg-subtle">
                    {pack.source.sheet} · {pack.source.source_range} · {pack.source.layout_kind.replace(/_/g, " ")}
                  </div>
                </div>
              </div>
              <span className="rounded-full bg-signal-good/10 px-2.5 py-1 text-xs font-medium text-signal-good ring-1 ring-signal-good/25">
                {pack.summary.join_coverage_pct.toFixed(0)}% mapped
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {pack.mappings.filter((mapping) => mapping.target !== "ignore").map((mapping) => (
                <div key={mapping.source} className="rounded-xl bg-black/[0.025] px-3 py-2 ring-1 ring-line">
                  <div className="text-xs font-medium text-fg">{mapping.source} → {mapping.target}</div>
                  <div className="mt-0.5 text-[11px] text-fg-subtle">
                    {(mapping.role_confidence * 100).toFixed(0)}% confidence
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Join coverage</div>
              <div className="mt-1 text-2xl font-bold num text-fg">
                {pack.summary.matched_rows}/{pack.summary.total_rows}
              </div>
              <div className="text-xs text-fg-subtle">analysis rows matched</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Largest gap</div>
              <div className="mt-1 text-2xl font-bold num text-fg">
                {fmtCompact(visibleLines.reduce(
                  (best, line) => Math.abs(line.gap) > Math.abs(best) ? line.gap : best,
                  0,
                ))}
              </div>
              <div className="text-xs text-fg-subtle">uploaded minus governed</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">Unmapped</div>
              <div className="mt-1 text-2xl font-bold num text-signal-warn">
                {fmtCompact(pack.summary.unmapped_amount)}
              </div>
              <div className="text-xs text-fg-subtle">held outside the comparison</div>
            </Card>
          </div>

          <Card title="BU flash vs governed books" subtitle={`${pack.period} · ${pack.scope.id}`}>
            <div className="divide-y divide-line">
              {visibleLines.map((line) => (
                <div key={line.line_id} className="grid gap-3 px-5 py-4 md:grid-cols-[12rem_1fr_7rem] md:items-center">
                  <div>
                    <div className="text-sm font-medium text-fg">
                      {adhocLineLabel(line.line_id, line.line_label, ov)}
                    </div>
                    <div className="text-[11px] text-fg-subtle">{pack.source.sheet} · {line.source_range}</div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-14 text-[10px] uppercase text-fg-subtle">Books</span>
                      <div className="h-2 rounded-full bg-fg-subtle/25" style={{ width: `${Math.max(2, Math.abs(line.actual) / maxAmount * 100)}%` }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-14 text-[10px] uppercase text-fg-subtle">Flash</span>
                      <div className="h-2 rounded-full bg-brick-500" style={{ width: `${Math.max(2, Math.abs(line.uploaded) / maxAmount * 100)}%` }} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-sm font-semibold num ${line.favorable ? "text-signal-good" : "text-signal-bad"}`}>
                      {line.gap >= 0 ? "+" : ""}{fmtCompact(line.gap)}
                    </div>
                    <div className="text-[11px] text-fg-subtle">
                      {line.gap_pct == null ? "—" : `${line.gap_pct > 0 ? "+" : ""}${line.gap_pct.toFixed(1)}%`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-brick/10 shrink-0">
                  <Sparkles className="h-5 w-5 text-brick-500" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-fg">What this file says vs our books</h2>
                  <ul className="mt-2 space-y-2">
                    {bullets.map((bullet) => (
                      <li key={bullet} className="flex gap-2 text-sm leading-relaxed text-fg-muted">
                        <span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-brick-500 shrink-0" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 text-signal-warn shrink-0" />
                <div>
                  <h2 className="text-sm font-semibold text-fg">Exceptions</h2>
                  {pack.exceptions.map((exception) => (
                    <div key={exception.code + exception.label} className="mt-2">
                      <div className="text-sm text-fg-muted">{exception.label}</div>
                      <div className="text-[11px] text-fg-subtle">
                        {fmtCompact(exception.amount)} · {pack.source.sheet} · {exception.source_range}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </>
      ) : preview ? (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="font-semibold text-fg">{preview.workbook.filename}</div>
              <div className="mt-0.5 text-xs text-fg-subtle">
                {preview.workbook.rows.length} rows · {preview.layoutKind.replace(/_/g, " ")} · confirm mapping before comparing to books
              </div>
            </div>
            {preview.workbook.sheets.length > 1 && (
              <select
                className="border border-line rounded-md px-2 py-1.5 text-sm bg-transparent"
                value={preview.workbook.selectedSheet}
                onChange={(event) => onSheetChange(event.target.value)}
              >
                {preview.workbook.sheets.map((sheet) => (
                  <option key={sheet} value={sheet}>{sheet}</option>
                ))}
              </select>
            )}
          </div>
          <div className="mt-4">
            <h2 className="text-sm font-semibold text-fg">Review inferred columns</h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">
              Confirm data type and role before running analysis.
            </p>
          </div>
          <AdhocInferenceStrip>
            {preview.mappings.map((mapping, index) => (
              <AdhocColumnInference
                key={mapping.source}
                mapping={mapping}
                layoutKind={preview.layoutKind}
                sampleValues={sampleValuesBySource[mapping.source] ?? []}
                onChange={(next) => {
                  setPreview((current) => current && {
                    ...current,
                    mappings: current.mappings.map((item, itemIndex) => (
                      itemIndex === index ? next : item
                    )),
                  });
                }}
              />
            ))}
          </AdhocInferenceStrip>
          <div className="mt-4 overflow-x-auto ring-1 ring-line rounded-xl">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-black/[0.03] text-left text-fg-subtle">
                  {preview.workbook.headers.map((header) => (
                    <th key={header} className="px-3 py-2 font-medium whitespace-nowrap">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.workbook.previewRows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-line">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="px-3 py-2 whitespace-nowrap text-fg">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={runAnalysis}>Analyze against books</Button>
          </div>
        </Card>
      ) : (
        <Card className="p-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-brick/10">
              <FileSpreadsheet className="h-6 w-6 text-brick-500" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-fg">Analyze a workbook against the close</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              Map an emailed BU flash to the same statement lines used by Variance Analysis,
              then see where it differs from the governed close. Recurring files belong on a
              governed ingestion pipeline.
            </p>
            <div className="mt-5 flex items-center justify-center gap-2 flex-wrap">
              <Button onClick={loadSample}>Use sample workbook</Button>
              <Button variant="neutral" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-1.5 inline h-4 w-4" />
                Upload workbook
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-fg-subtle">
              Accepts .xlsx, .xls, and .csv. Confirm the mapping before numbers are compared.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
