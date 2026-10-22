/** Browser-local demo calendar: shift seeded YYYY-MM / ISO dates to look current. */

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})([T\s].*)?$/;
const FY_RE = /^FY\d{4}$/;

const PERIOD_KEYS = new Set([
  "period", "active", "actual_period", "compare_period", "as_of_period",
]);
const DATE_KEYS = new Set([
  "today", "due_date", "paid_date", "invoice_date", "posting_date", "entry_date",
  "as_of_date", "target_close_date", "projected_finish_date", "start_date",
  "cutoff_date", "completed_ts", "created_ts", "started_ts", "updated_ts",
  "posted_ts", "approved_ts", "signed_off_ts", "explained_ts", "decision_ts",
  "ack_ts", "last_load", "renewal_date", "statement_date", "run_date",
  "in_service_date", "claim_date", "order_date", "submitted_ts", "event_ts",
  "worst_due", "date",
]);
const SKIP_KEYS = new Set([
  "task_id", "adjustment_id", "scenario_id", "linked_ref", "ref", "check_id",
  "activity_id", "conversation_id", "message_id", "event_id",
  "period_end",
]);
const TEXT_KEYS = new Set([
  "seed_question", "note", "narrative", "question", "explanation",
  "comments", "insights",
]);

export function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function monthsBetween(a: string, b: string): number {
  const am = PERIOD_RE.exec(a);
  const bm = PERIOD_RE.exec(b);
  if (!am || !bm) return 0;
  return (Number(bm[1]) * 12 + Number(bm[2])) - (Number(am[1]) * 12 + Number(am[2]));
}

export function shiftPeriod(period: string, months: number): string {
  const m = PERIOD_RE.exec(period);
  if (!m) return period;
  const total = Number(m[1]) * 12 + Number(m[2]) - 1 + months;
  const y = Math.floor(total / 12);
  const mo = (total % 12 + 12) % 12;
  return `${y.toString().padStart(4, "0")}-${String(mo + 1).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function shiftIsoDate(value: string, months: number): string {
  const m = DATE_RE.exec(value);
  if (!m) return value;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const rest = m[4] ?? "";
  const total = y * 12 + mo - 1 + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const srcDim = daysInMonth(y, mo);
  const dim = daysInMonth(ny, nm);
  const nd = day >= srcDim ? dim : Math.min(day, dim);
  return `${ny.toString().padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}${rest}`;
}

export function monthLabel(period: string): string {
  const m = PERIOD_RE.exec(period);
  if (!m) return period;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function quarterOf(period: string): string {
  const m = PERIOD_RE.exec(period);
  if (!m) return "";
  return `Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}

export function toSeedPeriod(displayPeriod: string, offset: number): string {
  return shiftPeriod(displayPeriod, -offset);
}

export function comparisonDisplayLabels(
  displayPeriod: string,
  window: "mtd" | "qtd" | "ytd",
  compare: "prior" | "prior_year" | "budget" | "scenario",
): { actual: string; compare: string } {
  if (!PERIOD_RE.test(displayPeriod)) return { actual: displayPeriod, compare: "" };
  const year = Number(displayPeriod.slice(0, 4));
  // Scenario compares against a published forecast named by the backend, not a
  // date-shifted period, so there's no display label to derive — the caller
  // falls back to the backend-provided compare period.
  if (window === "ytd") {
    return {
      actual: `${year} YTD`,
      compare: compare === "scenario" ? ""
        : compare === "budget" ? `${year} YTD Budget` : `${year - 1} YTD`,
    };
  }
  if (window === "qtd") {
    const actual = `${year}-${quarterOf(displayPeriod)}`;
    const prior = shiftPeriod(displayPeriod, compare === "prior_year" ? -12 : -3);
    return {
      actual,
      compare: compare === "scenario" ? ""
        : compare === "budget"
        ? `${actual} Budget`
        : `${prior.slice(0, 4)}-${quarterOf(prior)}`,
    };
  }
  const prior = shiftPeriod(displayPeriod, compare === "prior_year" ? -12 : -1);
  return {
    actual: displayPeriod,
    compare: compare === "scenario" ? ""
      : compare === "budget" ? `${displayPeriod} Budget` : prior,
  };
}

export function closeDayIndex(points: { t: number }[], todayT: number): number {
  return points.findIndex((point) => point.t === todayT);
}

export function withDisplayPeriod(text: string, displayPeriod: string): string {
  if (!PERIOD_RE.test(displayPeriod)) return text;
  return text.replace(/\d{4}-(?:0[1-9]|1[0-2])/, displayPeriod);
}

function rebuildPeriodMeta(obj: Record<string, unknown>, period: string): void {
  const m = PERIOD_RE.exec(period);
  if (!m) return;
  if ("month_label" in obj) obj.month_label = monthLabel(period);
  if ("year" in obj) obj.year = Number(m[1]);
  if ("month" in obj) obj.month = Number(m[2]);
  if ("quarter" in obj) obj.quarter = quarterOf(period);
  if ("days_in_period" in obj) obj.days_in_period = daysInMonth(Number(m[1]), Number(m[2]));
}

function mapString(key: string, value: string, offset: number, forWrite: boolean): string {
  if (FY_RE.test(value)) return value;
  const dir = forWrite ? -offset : offset;
  // Writes: only dates. Period query/body stays display; the backend maps to seed.
  if (forWrite) {
    if (DATE_KEYS.has(key) && DATE_RE.test(value)) return shiftIsoDate(value, dir);
    return value;
  }
  if (PERIOD_KEYS.has(key) && PERIOD_RE.test(value)) return shiftPeriod(value, dir);
  if (DATE_KEYS.has(key) && DATE_RE.test(value)) {
    if (key === "today") return localIsoDate();
    return shiftIsoDate(value, dir);
  }
  return value;
}

export function walkPayload(value: unknown, offset: number, forWrite = false): unknown {
  if (offset === 0 && !forWrite) {
    // Still override `today` to literal browser date when offset is 0 in June.
    if (value && typeof value === "object" && !Array.isArray(value)
        && "today" in (value as object) && typeof (value as { today: unknown }).today === "string") {
      return { ...(value as object), today: localIsoDate() };
    }
  }
  if (offset === 0) return value;
  if (Array.isArray(value)) return value.map((v) => walkPayload(v, offset, forWrite));
  if (!value || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SKIP_KEYS.has(k)) {
      out[k] = v;
      continue;
    }
    if (k === "dates" && Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? shiftIsoDate(item, forWrite ? -offset : offset) : walkPayload(item, offset, forWrite)));
      continue;
    }
    if (k === "periods" && Array.isArray(v)) {
      out[k] = v.map((item) => {
        if (!forWrite && typeof item === "string" && PERIOD_RE.test(item)) {
          return shiftPeriod(item, offset);
        }
        return walkPayload(item, offset, forWrite);
      });
      continue;
    }
    if (TEXT_KEYS.has(k) && !forWrite) {
      out[k] = shiftTextValue(v, offset);
      continue;
    }
    if (typeof v === "string") out[k] = mapString(k, v, offset, forWrite);
    else out[k] = walkPayload(v, offset, forWrite);
  }
  const period = out.period;
  if (typeof period === "string" && PERIOD_RE.test(period)) rebuildPeriodMeta(out, period);
  return out;
}

export function toDisplayPayload(value: unknown, offset: number): unknown {
  return walkPayload(value, offset, false);
}

export function toSeedPayload(value: unknown, offset: number): unknown {
  return walkPayload(value, offset, true);
}

function shiftTextValue(value: unknown, offset: number): unknown {
  if (typeof value === "string") return shiftDateTokens(value, offset);
  if (Array.isArray(value)) return value.map((item) => shiftTextValue(item, offset));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shiftTextValue(v, offset);
    }
    return out;
  }
  return value;
}

const TOKEN_RE = /(?<![\w-])\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?/g;

export function shiftDateTokens(text: string, offset: number): string {
  if (!text || offset === 0) return text;
  return text.replace(TOKEN_RE, (tok) => {
    if (PERIOD_RE.test(tok)) return shiftPeriod(tok, offset);
    if (DATE_RE.test(tok)) return shiftIsoDate(tok, offset);
    return tok;
  });
}

export function shiftGeniePayload(value: unknown, offset: number): unknown {
  if (offset === 0 || value == null) return value;
  if (typeof value === "string") return shiftDateTokens(value, offset);
  if (Array.isArray(value)) return value.map((v) => shiftGeniePayload(v, offset));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SKIP_KEYS.has(k) ? v : shiftGeniePayload(v, offset);
    }
    return out;
  }
  return value;
}
