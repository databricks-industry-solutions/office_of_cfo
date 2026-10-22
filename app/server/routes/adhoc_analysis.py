"""Ad-hoc analysis: sample pack plus stateless parse/run of an uploaded grid."""
from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..config import current_industry
from .statements import comparative_statement

router = APIRouter()

MAX_ADHOC_ROWS = 50_000
_UPLOAD_DELTAS = {
    "revenue": 0.03,
    "cogs": -0.02,
    "opex": 0.08,
    "interest_income": 0.02,
    "interest_expense": 0.05,
    "tax_expense": 0.01,
}
_EXPENSE_LINES = {"cogs", "opex", "interest_expense", "tax_expense"}
_INDUSTRY_UNMAPPED = {
    "consumer": 50.0,
    "software": 52.0,
    "fsi": 54.0,
    "energy": 56.0,
    "capmarkets": 58.0,
}
_HEADER_TARGETS = {
    "amt": "amount",
    "amount": "amount",
    "value": "amount",
    "uploaded": "amount",
    "account": "metric_id",
    "line": "metric_id",
    "metric": "metric_id",
    "kpi": "metric_id",
    "name": "metric_id",
    "month": "period",
    "period": "period",
    "date": "period",
    "version": "version",
    "scenario": "version",
    "type": "version",
}
_LINE_ALIASES = {
    "revenue": ["revenue", "net interest & fee income", "net interest and fee income"],
    "cogs": [
        "cogs", "cost of revenue", "cost of goods sold", "cost of services",
        "cost of energy",
    ],
    "opex": ["opex", "operating expenses", "operating expense"],
    "interest_income": ["interest income"],
    "interest_expense": ["interest expense"],
    "tax_expense": ["tax expense", "tax"],
}
_LABEL_TO_LINE: dict[str, str] = {}
_PERIOD_HEADER = re.compile(r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$")
_ALLOWED_TARGETS = {"metric_id", "period", "amount", "version", "ignore"}
_ALLOWED_DATA_TYPES = {"text", "number", "date", "datetime", "time", "boolean"}


class MappingIn(BaseModel):
    source: str
    target: str
    data_type: str = "text"
    data_type_confidence: float = 0.0
    role_confidence: float = 0.0
    user_confirmed_data_type: bool = False
    user_confirmed_role: bool = False
    confidence: float | None = None


class ParseIn(BaseModel):
    analysis_id: str | None = None
    filename: str
    sheet: str = "Sheet1"
    headers: list[str] = Field(default_factory=list)
    sample_rows: list[list[Any]] = Field(default_factory=list)
    row_count: int = 0


class RunIn(BaseModel):
    analysis_id: str | None = None
    filename: str
    sheet: str = "Sheet1"
    headers: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    mappings: list[MappingIn] = Field(default_factory=list)
    scope_type: str = "consolidated"
    scope_id: str = "ALL"
    period: str | None = None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _round(value: float) -> float:
    return round(float(value), 2)


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


for _line_id, _labels in _LINE_ALIASES.items():
    _LABEL_TO_LINE[_line_id] = _line_id
    for _label in _labels:
        _LABEL_TO_LINE[_norm(_label)] = _line_id


def _period_key(value: Any) -> str | None:
    raw = str(value or "").strip()
    match = re.match(r"^(\d{4})[-/](\d{1,2})", raw)
    if match:
        return f"{match.group(1)}-{int(match.group(2)):02d}"
    slash = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$", raw)
    if slash:
        year = int(slash.group(3))
        if year < 100:
            year += 2000
        return f"{year}-{int(slash.group(1)):02d}"
    return raw or None


def _is_period_header(header: str) -> bool:
    return bool(_PERIOD_HEADER.match(str(header).strip()))


def _as_dict(body: Any) -> dict:
    if isinstance(body, dict):
        return body
    if hasattr(body, "model_dump"):
        return body.model_dump()
    return dict(body)


def _parse_amount(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _round(float(value))
    cleaned = re.sub(r"[,$]", "", str(value)).strip()
    if not cleaned:
        return None
    try:
        return _round(float(cleaned))
    except ValueError:
        return None


def _line_id_for(label: Any) -> str | None:
    return _LABEL_TO_LINE.get(_norm(label))


def _looks_number(value: Any) -> bool:
    return _parse_amount(value) is not None


def _classify_value(value: Any) -> str:
    raw = str(value or "").strip()
    if re.fullmatch(r"(?i:true|false|yes|no)", raw):
        return "boolean"
    if re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(:\d{2})?", raw):
        return "datetime"
    if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", raw):
        return "time"
    if _period_key(raw) and (
        re.fullmatch(r"\d{4}[-/]\d{1,2}([-/]\d{1,2})?", raw)
        or re.fullmatch(r"\d{1,2}/\d{1,2}/(\d{2}|\d{4})", raw)
    ):
        return "date"
    if _looks_number(raw):
        return "number"
    return "text"


def _default_data_type(target: str) -> str:
    return "number" if target == "amount" else "text"


def _mapping_warning(mapping: dict, layout_kind: str) -> str | None:
    target, kind = mapping["target"], mapping["data_type"]
    if target == "ignore":
        return None
    if target == "amount" and kind != "number":
        return f"Amount usually expects Number, not {kind.title()}."
    if target in {"metric_id", "version"} and kind != "text":
        return f"{target} usually expects Text, not {kind.title()}."
    if target == "period" and layout_kind != "account_month_pivot" \
            and kind not in {"date", "datetime", "text"}:
        return f"Period usually expects Date, Date & time, or Text, not {kind.title()}."
    return None


def _coerce_value(value: Any, data_type: str) -> Any | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if data_type == "number":
        return _parse_amount(value)
    if data_type == "text":
        return raw
    if data_type in {"date", "datetime"}:
        return _period_key(value)
    if data_type == "time":
        if re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", raw):
            return raw
        return None
    if data_type == "boolean":
        if re.fullmatch(r"(?i:true|false|yes|no)", raw):
            return raw.lower() in ("true", "yes")
        return None
    return raw


def _normalize_mapping(item: dict, layout_kind: str) -> dict:
    target = str(item.get("target") or "ignore")
    if target not in _ALLOWED_TARGETS:
        raise HTTPException(400, f"Unknown mapping target {target}.")
    data_type = str(item.get("data_type") or _default_data_type(target))
    if data_type not in _ALLOWED_DATA_TYPES:
        raise HTTPException(400, f"Unknown data type {data_type}.")
    role_confidence = float(
        item.get("role_confidence")
        if item.get("role_confidence") is not None
        else (item.get("confidence") or 0)
    )
    data_type_confidence = float(item.get("data_type_confidence") or 0)
    user_confirmed_data_type = bool(item.get("user_confirmed_data_type"))
    user_confirmed_role = bool(item.get("user_confirmed_role"))
    if user_confirmed_data_type:
        data_type_confidence = 1.0
    if user_confirmed_role:
        role_confidence = 1.0
    elif _mapping_warning({"target": target, "data_type": data_type}, layout_kind):
        role_confidence = min(role_confidence, 0.5)
    return {
        "source": str(item.get("source")),
        "target": target,
        "data_type": data_type,
        "data_type_confidence": data_type_confidence,
        "role_confidence": role_confidence,
        "user_confirmed_data_type": user_confirmed_data_type,
        "user_confirmed_role": user_confirmed_role,
        "confidence": role_confidence,
    }


def _mapping_warnings(mappings: list[dict], layout_kind: str) -> list[str]:
    warnings = []
    for mapping in mappings:
        warning = _mapping_warning(mapping, layout_kind)
        if warning:
            warnings.append(warning)
    return warnings


def _infer_data_type(values: list[Any]) -> tuple[str, float]:
    nonempty = [value for value in values if str(value or "").strip()]
    if not nonempty:
        return "text", 0.0
    counts: dict[str, int] = {}
    for value in nonempty:
        kind = _classify_value(value)
        counts[kind] = counts.get(kind, 0) + 1
    kind, count = max(counts.items(), key=lambda item: item[1])
    ratio = count / len(nonempty)
    if kind != "text" and ratio < 0.8:
        return "text", round(1 - ratio, 2)
    return kind, round(ratio, 2)


def _suggest_target(header: str, data_type: str) -> tuple[str, float]:
    if _is_period_header(header):
        return "period", 0.99
    mapped = _HEADER_TARGETS.get(_norm(header))
    if mapped:
        return mapped, 0.96 if mapped == "amount" else 0.98
    return "ignore", 0.4


def _layout_kind(headers: list[str]) -> str:
    period_headers = [h for h in headers if _is_period_header(h)]
    if len(period_headers) >= 2:
        return "account_month_pivot"
    return "flat"


def _col_index(headers: list[str]) -> dict[str, int]:
    return {str(header): idx for idx, header in enumerate(headers)}


def _cell(row: list[Any], idx: int | None) -> Any:
    if idx is None or idx < 0 or idx >= len(row):
        return ""
    return row[idx]


def _assemble_pack(
    *,
    analysis_id: str,
    industry: str,
    period: str,
    scope_type: str,
    scope_id: str,
    source: dict,
    mappings: list[dict],
    statement_lines: list[dict],
    uploaded_by_line: dict[str, dict],
    unmapped: list[dict],
    invalid_values: list[dict],
    matched_rows: int,
    total_rows: int,
    warnings: list[str] | None = None,
) -> dict:
    lines = []
    for row in statement_lines:
        line_id = str(row.get("line_id") or "")
        uploaded_row = uploaded_by_line.get(line_id)
        if not uploaded_row:
            continue
        actual = _round(row.get("actual") or 0)
        uploaded = _round(uploaded_row["amount"])
        gap = _round(uploaded - actual)
        lines.append({
            "line_id": line_id,
            "line_label": row.get("line_label") or line_id,
            "sort_order": int(row.get("sort_order") or 99),
            "actual": actual,
            "uploaded": uploaded,
            "gap": gap,
            "gap_pct": None if not actual else round(gap / abs(actual) * 100, 1),
            "favorable": gap >= 0 if line_id not in _EXPENSE_LINES else gap <= 0,
            "source_range": uploaded_row.get("source_range") or source.get("source_range"),
        })
    lines.sort(key=lambda item: item["sort_order"])

    unmapped_amount = _round(sum(item["amount"] for item in unmapped))
    if not total_rows:
        total_rows = (matched_rows + len(unmapped)) if (matched_rows or unmapped) else 0
    largest = max(lines, key=lambda item: abs(item["gap"]), default=None)
    bullets = []
    if largest:
        direction = "above" if largest["gap"] >= 0 else "below"
        coverage_line = (
            f"{len(lines)} mapped lines cover {round(len(lines) / total_rows * 100):.0f}% "
            "of the uploaded analysis rows."
            if total_rows else
            f"{len(lines)} mapped lines have no accepted upload rows."
        )
        bullets = [
            f"The BU flash is {abs(largest['gap']):,.0f} {direction} the governed "
            f"close on {largest['line_label']}.",
            coverage_line,
            f"One unmapped line worth {unmapped_amount:,.0f} remains outside the comparison."
            if unmapped else
            f"{len(lines)} mapped lines cover the uploaded analysis rows.",
        ]
    return {
        "analysis_id": analysis_id,
        "period": period,
        "industry": industry,
        "scope": {"type": scope_type, "id": scope_id},
        "source": source,
        "mappings": mappings,
        "summary": {
            "matched_rows": matched_rows,
            "total_rows": total_rows,
            "join_coverage_pct": (
                round(matched_rows / total_rows * 100, 1) if total_rows else 0.0
            ),
            "unmapped_amount": unmapped_amount if lines or unmapped else 0.0,
            "largest_gap_line_id": largest["line_id"] if largest else None,
        },
        "lines": lines,
        "exceptions": ([{
            "code": "unmapped_metric",
            "label": item["label"],
            "amount": item["amount"],
            "source_range": item.get("source_range") or source.get("source_range"),
        } for item in unmapped] + [{
            "code": "invalid_value",
            "label": item["label"],
            "amount": item["amount"],
            "source_range": item.get("source_range") or source.get("source_range"),
        } for item in invalid_values]) if lines or unmapped or invalid_values else [],
        "warnings": warnings or [],
        "narrative": {"available": bool(bullets), "bullets": bullets},
    }


def parse_pack(body: ParseIn | dict) -> dict:
    payload = _as_dict(body)
    headers = [str(h) for h in (payload.get("headers") or [])]
    sample_rows = payload.get("sample_rows") or []
    layout_kind = _layout_kind(headers)
    mappings = []
    for col_idx, header in enumerate(headers):
        column_values = [
            row[col_idx] for row in sample_rows
            if col_idx < len(row)
        ]
        data_type, data_type_confidence = _infer_data_type(column_values)
        target, role_confidence = _suggest_target(header, data_type)
        mappings.append(_normalize_mapping({
            "source": header,
            "target": target,
            "data_type": data_type,
            "data_type_confidence": data_type_confidence,
            "role_confidence": role_confidence,
            "user_confirmed_data_type": False,
            "user_confirmed_role": False,
            "confidence": role_confidence,
        }, layout_kind))
    filename = str(payload.get("filename") or "workbook.xlsx")
    sheet = str(payload.get("sheet") or "Sheet1")
    warnings = [] if headers else ["No header row detected."]
    warnings.extend(_mapping_warnings(mappings, layout_kind))
    return {
        "analysis_id": payload.get("analysis_id") or f"parse-{_slug(filename)}",
        "filename": filename,
        "sheet": sheet,
        "layout_kind": layout_kind,
        "mappings": mappings,
        "warnings": warnings,
        "row_count": int(payload.get("row_count") or 0),
    }


def _facts_from_grid(
    headers: list[str],
    rows: list[list[Any]],
    mappings: list[dict],
    chrome_period: str,
    sheet: str,
) -> tuple[dict[str, dict], list[dict], list[dict], int, int]:
    by_header = _col_index(headers)
    mapping_by_source = {item["source"]: item for item in mappings}
    targets = {
        item["source"]: item["target"]
        for item in mappings
        if item.get("target") in _ALLOWED_TARGETS and item.get("target") != "ignore"
    }
    metric_header = next((src for src, tgt in targets.items() if tgt == "metric_id"), None)
    amount_header = next((src for src, tgt in targets.items() if tgt == "amount"), None)
    period_headers = [src for src, tgt in targets.items() if tgt == "period"]
    pivot_headers = [src for src in period_headers if _is_period_header(src)]
    metric_idx = by_header.get(metric_header) if metric_header else None
    amount_idx = by_header.get(amount_header) if amount_header else None
    period_idx = None
    if period_headers and not pivot_headers:
        period_idx = by_header.get(period_headers[0])

    uploaded_by_line: dict[str, dict] = {}
    unmapped_by_label: dict[str, dict] = {}
    invalid_values: list[dict] = []
    matched_rows = 0
    fact_rows = 0

    def _record_invalid(source: str, raw_value: Any, source_range: str) -> None:
        invalid_values.append({
            "code": "invalid_value",
            "label": f"{source}: {raw_value}",
            "amount": 0.0,
            "source_range": f"{sheet} · {source_range}",
        })

    def _mark_zero_upload(line_id: str | None, source_range: str) -> None:
        if not line_id or line_id in uploaded_by_line:
            return
        uploaded_by_line[line_id] = {
            "amount": 0.0,
            "source_range": f"{sheet} · {source_range}",
        }

    def _read_amount(
        source: str,
        value: Any,
        source_range: str,
    ) -> tuple[str, float | None]:
        mapping = mapping_by_source.get(source, {})
        raw = str(value or "").strip()
        if source in pivot_headers:
            if not raw:
                return "empty", None
            parsed = _parse_amount(value)
            if parsed is None:
                _record_invalid(source, raw, source_range)
                return "invalid", None
            return "valid", parsed
        data_type = mapping.get("data_type") or _default_data_type(
            mapping.get("target") or "amount",
        )
        if mapping.get("target") == "amount" and data_type != "number":
            if raw:
                _record_invalid(source, raw, source_range)
                return "invalid", None
            return "empty", None
        if not raw:
            return "empty", None
        parsed = _parse_amount(value)
        if parsed is None:
            _record_invalid(source, raw, source_range)
            return "invalid", None
        return "valid", parsed

    def _valid_period(raw: str, period: str | None, data_type: str) -> bool:
        if not period:
            return False
        if data_type == "text":
            return True
        if data_type == "datetime":
            return bool(
                re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(:\d{2})?", raw)
                or re.fullmatch(r"\d{4}-\d{2}", period)
            )
        return bool(
            re.fullmatch(r"\d{4}-\d{2}", period)
            or re.fullmatch(r"\d{4}[-/]\d{1,2}([-/]\d{1,2})?", raw)
            or re.fullmatch(r"\d{1,2}/\d{1,2}/(\d{2}|\d{4})", raw)
        )

    def _read_period(
        value: Any,
        source: str | None,
        source_range: str,
    ) -> tuple[str, str | None]:
        if source is None:
            return "valid", chrome_period
        raw = str(value or "").strip()
        if not raw:
            return "valid", chrome_period
        mapping = mapping_by_source.get(source, {})
        data_type = mapping.get("data_type") or _default_data_type("period")
        coerced = _coerce_value(value, data_type)
        period = _period_key(coerced) if coerced is not None else None
        if not _valid_period(raw, period, data_type):
            _record_invalid(source, raw, source_range)
            return "invalid", None
        return "valid", period

    for row_i, row in enumerate(rows):
        label = _cell(row, metric_idx)
        line_id = _line_id_for(label)
        excel_row = row_i + 2
        source_range = f"A{excel_row}:E{excel_row}"
        cells: list[tuple[str, str | None, float | None]] = []
        if pivot_headers:
            for header in pivot_headers:
                amount_status, amount = _read_amount(
                    header,
                    _cell(row, by_header.get(header)),
                    source_range,
                )
                if amount_status == "invalid":
                    _mark_zero_upload(line_id, source_range)
                    continue
                if amount_status == "empty" or amount is None:
                    continue
                cells.append(("valid", _period_key(header), amount))
        else:
            period_source = period_headers[0] if period_idx is not None else None
            period_status, period = _read_period(
                _cell(row, period_idx),
                period_source,
                source_range,
            )
            if period_status == "invalid":
                _mark_zero_upload(line_id, source_range)
                continue
            amount_source = amount_header or ""
            amount_status, amount = (
                _read_amount(amount_source, _cell(row, amount_idx), source_range)
                if amount_idx is not None else ("empty", None)
            )
            if amount_status == "invalid":
                _mark_zero_upload(line_id, source_range)
                continue
            if amount_status == "empty" or amount is None:
                continue
            cells.append((period_status, period, amount))

        for period_status, period, amount in cells:
            if period_status == "invalid" or amount is None:
                continue
            if period and chrome_period and period != chrome_period:
                continue
            fact_rows += 1
            if not line_id:
                key = str(label or "Unmapped")
                current = unmapped_by_label.setdefault(key, {
                    "label": key,
                    "amount": 0.0,
                    "source_range": f"{sheet} · {source_range}",
                })
                current["amount"] = _round(current["amount"] + amount)
                continue
            matched_rows += 1
            current = uploaded_by_line.setdefault(line_id, {
                "amount": 0.0,
                "source_range": f"{sheet} · {source_range}",
            })
            current["amount"] = _round(current["amount"] + amount)

    return uploaded_by_line, list(unmapped_by_label.values()), invalid_values, matched_rows, fact_rows


def run_pack(body: RunIn | dict) -> dict:
    payload = _as_dict(body)
    rows = payload.get("rows") or []
    if len(rows) > MAX_ADHOC_ROWS:
        raise HTTPException(400, f"Workbooks are limited to {MAX_ADHOC_ROWS:,} rows.")
    headers = [str(h) for h in (payload.get("headers") or [])]
    layout_kind = _layout_kind(headers)
    mappings = [
        _normalize_mapping(_as_dict(item), layout_kind)
        for item in (payload.get("mappings") or [])
    ]

    scope_type = str(payload.get("scope_type") or "consolidated")
    scope_id = str(payload.get("scope_id") or "ALL")
    period = payload.get("period")
    industry = current_industry()
    statement = comparative_statement(
        "income",
        window="mtd",
        compare="prior",
        scope_type=scope_type,
        scope_id=scope_id,
        period=period,
    )
    resolved_period = str(statement.get("period") or period or "")
    filename = str(payload.get("filename") or "workbook.xlsx")
    sheet = str(payload.get("sheet") or "Sheet1")
    filter_period = _period_key(period) or resolved_period
    uploaded_by_line, unmapped, invalid_values, matched_rows, fact_rows = _facts_from_grid(
        headers, rows, mappings, filter_period, sheet,
    )
    return _assemble_pack(
        analysis_id=str(payload.get("analysis_id") or f"upload-{_slug(filename)}"),
        industry=industry,
        period=resolved_period,
        scope_type=scope_type,
        scope_id=scope_id,
        source={
            "filename": filename,
            "sheet": sheet,
            "source_range": f"A1:{chr(64 + min(26, max(1, len(headers))))}{len(rows) + 1}",
            "layout_kind": layout_kind,
        },
        mappings=mappings,
        statement_lines=list(statement.get("lines") or []),
        uploaded_by_line=uploaded_by_line,
        unmapped=unmapped,
        invalid_values=invalid_values,
        matched_rows=matched_rows,
        total_rows=fact_rows,
        warnings=_mapping_warnings(mappings, layout_kind),
    )


@router.get("/adhoc-analysis/sample")
def sample_pack(
    scope_type: str = Query("consolidated"),
    scope_id: str = Query("ALL"),
    period: str = Query(None),
):
    """Build a deterministic BU-flash comparison from current governed books."""
    industry = current_industry()
    statement = comparative_statement(
        "income",
        window="mtd",
        compare="prior",
        scope_type=scope_type,
        scope_id=scope_id,
        period=period,
    )
    resolved_period = str(statement.get("period") or period or "")
    uploaded_by_line = {}
    statement_lines = list(statement.get("lines") or [])
    for row in statement_lines:
        line_id = str(row.get("line_id") or "")
        if line_id not in _UPLOAD_DELTAS:
            continue
        actual = _round(row.get("actual") or 0)
        uploaded_by_line[line_id] = {
            "amount": _round(actual * (1 + _UPLOAD_DELTAS[line_id])),
            "source_range": f"B{len(uploaded_by_line) + 3}:E{len(uploaded_by_line) + 3}",
        }
    unmapped_amount = _INDUSTRY_UNMAPPED[industry]
    unmapped = ([{
        "label": "Discretionary projects",
        "amount": unmapped_amount,
        "source_range": "A9:E9",
    }] if uploaded_by_line else [])
    matched = len(uploaded_by_line)
    return _assemble_pack(
        analysis_id=f"sample-{industry}-{resolved_period}-{_slug(scope_type)}-{_slug(scope_id)}",
        industry=industry,
        period=resolved_period,
        scope_type=scope_type,
        scope_id=scope_id,
        source={
            "filename": f"bu_flash_{industry}.xlsx",
            "sheet": "BU Flash",
            "source_range": "A1:E9",
            "layout_kind": "account_month_pivot",
        },
        mappings=[
            {"source": "Account", "target": "metric_id", "data_type": "text",
             "data_type_confidence": 1.0, "role_confidence": 0.98,
             "user_confirmed_data_type": False, "user_confirmed_role": False,
             "confidence": 0.98},
            {"source": "Month", "target": "period", "data_type": "date",
             "data_type_confidence": 1.0, "role_confidence": 0.99,
             "user_confirmed_data_type": False, "user_confirmed_role": False,
             "confidence": 0.99},
            {"source": "Amt", "target": "amount", "data_type": "number",
             "data_type_confidence": 1.0, "role_confidence": 0.96,
             "user_confirmed_data_type": False, "user_confirmed_role": False,
             "confidence": 0.96},
            {"source": "Version", "target": "version", "data_type": "text",
             "data_type_confidence": 1.0, "role_confidence": 0.99,
             "user_confirmed_data_type": False, "user_confirmed_role": False,
             "confidence": 0.99},
        ],
        statement_lines=statement_lines,
        uploaded_by_line=uploaded_by_line,
        unmapped=unmapped,
        invalid_values=[],
        matched_rows=matched,
        total_rows=matched + len(unmapped) if matched or unmapped else 0,
        warnings=[],
    )


@router.post("/adhoc-analysis/parse")
def parse_route(body: ParseIn):
    return parse_pack(body)


@router.post("/adhoc-analysis/run")
def run_route(body: RunIn):
    return run_pack(body)
