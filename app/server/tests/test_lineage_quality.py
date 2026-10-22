"""Canonical lineage-quality contract: classification, graph/table counts,
scope, activity, pagination, and partial-source behaviour.

Pure unit tests — no warehouse, no Lakebase, no network.

Run: python app/server/tests/test_lineage_quality.py
"""
from __future__ import annotations

import pathlib
import sys

_APP = pathlib.Path(__file__).resolve().parents[2]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from server.lineage_quality import (  # noqa: E402
    FLOW_IDS,
    FLOWS,
    STAGES,
    assemble,
    build_graph,
    demo_evidence,
    filter_records,
    overlay_success_totals,
    paginate,
    records_response,
    summarize,
    synthetic_success,
)


def _coverage_map(coverage_ok=True, row_count=1000, last_load="2026-06-30T23:00:00"):
    return {
        fid: {
            "row_count": row_count if coverage_ok else None,
            "last_load": last_load if coverage_ok else None,
            "available": coverage_ok,
        }
        for fid in FLOW_IDS
    }


def _store(coverage_ok=True, row_count=1000, last_load="2026-06-30T23:00:00"):
    coverage = _coverage_map(coverage_ok, row_count, last_load)
    issues = demo_evidence(period="2026-06", source_label=lambda token: token)
    successes = [
        {
            "record_id": f"GL-OK-{i}",
            "flow_id": "gl",
            "status": "success",
            "stage": "post_ingestion",
            "source_system": "SAP / AFAS",
            "domain": "General Ledger",
            "value_chain": "Record to Report",
            "table": "gl_journal_entries",
            "entity": "BU-100",
            "amount": 100.0 + i,
            "event_ts": last_load,
            "regions": ["AMER"],
            "rule": None,
            "message": None,
            "attributes": {"je_id": f"GL-OK-{i}"},
            "provenance": {"source_table": "gl_journal_entries", "load_id": "load-1"},
            "issues": [],
            "activity": [],
        }
        for i in range(5)
    ]
    activity = [
        {
            "ts": "2026-06-30T18:00:00",
            "actor": "Controller",
            "action": "adjustment_posted",
            "detail": "Posted correcting entry for unbalanced batch",
            "record_id": "JE-2026-06-LEGACY01",
            "flow_id": "gl",
        },
        {
            "ts": "2026-06-30T19:00:00",
            "actor": "ZeroOps",
            "action": "repair_proposed",
            "detail": "Proposed schema mapping amount → adjustment_amount",
            "record_id": "ADJ-ACCRUAL-DRIFT",
            "flow_id": "gl",
        },
    ]
    return assemble(
        coverage=coverage,
        issue_records=issues,
        success_records=successes,
        activity=activity,
        coverage_ok=coverage_ok,
    )


def test_flow_ids_are_stable_and_industry_agnostic():
    assert FLOW_IDS == (
        "gl", "ar", "sales-orders", "ap", "procurement",
        "inventory", "product-costs", "fixed-assets", "bank",
        "payroll", "staff-expenses", "planning",
    )
    a = demo_evidence("2026-06", lambda t: "NetSuite" if "SAP" in t else t)
    b = demo_evidence("2026-06", lambda t: "SAP IS-U" if "SAP" in t else t)
    assert {r["flow_id"] for r in a} == {r["flow_id"] for r in b}
    assert all(r["flow_id"] in FLOW_IDS for r in a)


def test_demo_evidence_includes_ingestion_and_post_ingestion():
    rows = demo_evidence("2026-06", lambda t: t)
    stages = {r["stage"] for r in rows}
    assert "ingestion" in stages
    assert "post_ingestion" in stages
    assert "reconciliation" in stages
    statuses = {r["status"] for r in rows}
    assert "error" in statuses
    assert "warning" in statuses
    assert any(r["stage"] == "ingestion" and r["status"] == "error" for r in rows)
    warns = {r["flow_id"] for r in rows if r["status"] == "warning"}
    assert set(FLOW_IDS) <= warns
    n_warn = sum(1 for r in rows if r["status"] == "warning")
    assert 25 <= n_warn <= 50
    assert {f["source_token"] for f in FLOWS} >= {"CRM", "Planning"}


def test_graph_and_record_counts_match():
    payload = _store()
    graph = payload["graph"]
    totals = graph["summary"]
    records = payload["records"]
    by_status = summarize(records)
    assert totals["success"] == by_status["success"]
    assert totals["warning"] == by_status["warning"]
    assert totals["error"] == by_status["error"]
    assert totals["total"] == by_status["total"]
    # Every status-banded link value is the count of records on that hop.
    gl_errors = [r for r in records if r["flow_id"] == "gl" and r["status"] == "error"]
    hop = next(
        l for l in graph["links"]
        if l["flow_id"] == "gl" and l["status"] == "error" and l["source"].startswith("sys:")
    )
    assert hop["value"] == len(gl_errors)


def test_pagination_does_not_change_totals():
    payload = _store()
    recs = payload["records"]
    page, total = paginate(recs, offset=2, limit=3)
    assert total == len(recs)
    assert len(page) == 3
    page2, total2 = paginate(recs, offset=0, limit=50)
    assert total2 == total
    assert len(page2) == min(50, total)


def test_filter_by_flow_status_stage_and_search():
    payload = _store()
    recs = payload["records"]
    gl = filter_records(recs, flow_id="gl")
    assert gl and all(r["flow_id"] == "gl" for r in gl)
    errs = filter_records(recs, status="error")
    assert errs and all(r["status"] == "error" for r in errs)
    ingest = filter_records(recs, stage="ingestion")
    assert ingest and all(r["stage"] == "ingestion" for r in ingest)
    assert set(STAGES) >= {r["stage"] for r in recs}
    hit = filter_records(recs, search="LEGACY01")
    assert any("LEGACY01" in r["record_id"] for r in hit)


def test_scope_isolation_hides_other_regions():
    payload = _store()
    emea = filter_records(payload["records"], regions=["EMEA"])
    assert emea
    for r in emea:
        regions = r.get("regions") or []
        assert not regions or "EMEA" in regions


def test_related_activity_is_attached_to_matching_records():
    payload = _store()
    legacy = next(r for r in payload["records"] if r["record_id"] == "JE-2026-06-LEGACY01")
    actions = {a["action"] for a in legacy["activity"]}
    assert "adjustment_posted" in actions
    drift = next(r for r in payload["records"] if r["record_id"] == "ADJ-ACCRUAL-DRIFT")
    assert any(a["action"] == "repair_proposed" for a in drift["activity"])
    clean = next(r for r in payload["records"] if r["status"] == "success")
    assert clean["activity"] == []


def test_partial_source_is_unavailable_not_green_or_empty():
    payload = _store(coverage_ok=False)
    graph = payload["graph"]
    assert graph["partial"] is True
    assert graph["summary"]["success"] == 0
    assert graph["summary"]["unavailable"] > 0
    assert all(l["status"] != "success" for l in graph["links"])
    assert any(l["status"] == "unavailable" for l in graph["links"])
    # Seeded exceptions remain visible so the page is not empty.
    assert any(r["status"] == "error" for r in payload["records"])


def test_governed_totals_match_graph_including_shared_table_flows():
    """Success volume comes from row counts, so flows that share a table (inventory
    and product-costs) must count in the table exactly as they do in the Sankey."""
    payload = _store()
    totals = {fid: 1000 for fid in FLOW_IDS}
    graph = build_graph(
        payload["records"], _coverage_map(), True, lambda t: t, totals,
    )

    everything = records_response(
        payload["records"], success_totals=totals, offset=0, limit=10,
    )
    assert everything["totals"]["success"] == graph["summary"]["success"]
    assert everything["totals"]["total"] == graph["summary"]["total"]

    # product-costs shares subledger_inventory with inventory, so it has no
    # sampled rows of its own — its ribbon still carries governed volume.
    band = next(
        l for l in graph["links"]
        if l["flow_id"] == "product-costs" and l["status"] == "success"
        and l["source"].startswith("sys:")
    )
    drill = records_response(
        payload["records"], node_id="dom:Product Costs",
        success_totals=totals, offset=0, limit=10,
    )
    assert drill["totals"]["success"] == band["value"]


def test_status_tab_filters_rows_without_collapsing_summary_totals():
    payload = _store()
    totals = {fid: 1000 for fid in FLOW_IDS}
    everything = records_response(
        payload["records"], success_totals=totals, offset=0, limit=10,
    )

    warnings = records_response(
        payload["records"], status="warning", success_totals=totals,
        offset=0, limit=10,
    )

    assert warnings["totals"] == everything["totals"]
    assert warnings["total"] == everything["totals"]["warning"]
    assert all(record["status"] == "warning" for record in warnings["records"])


def test_search_does_not_inherit_governed_success_volume():
    payload = _store()
    totals = {fid: 1000 for fid in FLOW_IDS}
    resp = records_response(
        payload["records"], search="LEGACY01", success_totals=totals,
        offset=0, limit=10,
    )
    assert resp["totals"]["success"] == 0
    assert resp["total"] == len(resp["records"])


def test_warning_bands_exist_on_the_graph():
    payload = _store()
    graph = payload["graph"]
    assert any(l["status"] == "warning" for l in graph["links"])
    assert graph["summary"]["warning"] >= len(FLOW_IDS)


def test_success_samples_exist_for_shared_and_new_flows():
    extra = (
        synthetic_success("product-costs", 8, lambda t: t, "2026-06")
        + synthetic_success("planning", 8, lambda t: t, "2026-06")
    )
    pc = records_response(extra, flow_id="product-costs", status="success", limit=10)
    assert pc["records"] and all(r["flow_id"] == "product-costs" for r in pc["records"])
    pl = records_response(extra, flow_id="planning", status="success", limit=10)
    assert pl["records"] and all(r["flow_id"] == "planning" for r in pl["records"])
    warn = records_response(
        demo_evidence("2026-06", lambda t: t), flow_id="ap", status="warning", limit=10,
    )
    assert warn["records"] and all(r["status"] == "warning" for r in warn["records"])


def test_records_response_contract():
    payload = _store()
    resp = records_response(payload["records"], flow_id="ap", offset=0, limit=10)
    assert set(resp) >= {"records", "total", "offset", "limit", "totals", "matched_flow_ids"}
    assert resp["totals"]["total"] == resp["total"]
    assert resp["matched_flow_ids"] == ["ap"]
    for rec in resp["records"]:
        assert {"record_id", "flow_id", "status", "stage", "provenance", "issues", "activity"} <= set(rec)


def test_search_matched_flow_ids_drive_sankey_highlight():
    payload = _store()
    resp = records_response(payload["records"], search="LEGACY01", offset=0, limit=10)
    assert resp["matched_flow_ids"] == ["gl"]
    empty = records_response(payload["records"], search="zzzz-nope", offset=0, limit=10)
    assert empty["matched_flow_ids"] == []


def test_overlay_drops_company_volume_when_scope_is_active():
    company = {fid: 1000 for fid in FLOW_IDS}
    assert overlay_success_totals(company, scoped=False) == company
    assert overlay_success_totals(company, scoped=True) is None
    scoped = {fid: 40 for fid in FLOW_IDS}
    assert overlay_success_totals(company, scoped=True, scoped_totals=scoped) == scoped


def test_scoped_graph_headlines_and_ribbons_match_scope():
    payload = _store()
    emea = filter_records(payload["records"], regions=["EMEA"])
    company = {fid: 1000 for fid in FLOW_IDS}
    scoped = {fid: 40 for fid in FLOW_IDS}
    totals = overlay_success_totals(company, scoped=True, scoped_totals=scoped)
    graph = build_graph(emea, _coverage_map(), True, lambda t: t, totals)
    assert graph["summary"]["success"] == 40 * len(FLOW_IDS)
    assert graph["summary"]["warning"] == summarize(emea)["warning"]
    assert graph["summary"]["error"] == summarize(emea)["error"]
    ribbon = next(
        l for l in graph["links"]
        if l["flow_id"] == "gl" and l["status"] == "success" and l["source"].startswith("sys:")
    )
    assert ribbon["value"] == 40
    dropped = overlay_success_totals(company, scoped=True)
    fallback = build_graph(emea, _coverage_map(), True, lambda t: t, dropped)
    assert fallback["summary"]["success"] == summarize(emea)["success"]
    assert fallback["summary"]["success"] < sum(company.values())


def test_scoped_records_response_uses_scoped_governed_volume():
    payload = _store()
    company = {fid: 1000 for fid in FLOW_IDS}
    scoped = {fid: 40 for fid in FLOW_IDS}
    resp = records_response(
        payload["records"], regions=["EMEA"],
        success_totals=overlay_success_totals(company, scoped=True, scoped_totals=scoped),
        offset=0, limit=10,
    )
    assert resp["totals"]["success"] == 40 * len(FLOW_IDS)
    fallback = records_response(
        payload["records"], regions=["EMEA"],
        success_totals=overlay_success_totals(company, scoped=True),
        offset=0, limit=10,
    )
    emea = filter_records(payload["records"], regions=["EMEA"])
    assert fallback["totals"]["success"] == summarize(emea)["success"]


def test_business_unit_filter_excludes_sibling_units_in_the_same_region():
    payload = _store()
    amer = filter_records(payload["records"], regions=["AMER"])
    bu100 = filter_records(payload["records"], business_units=["BU-100"])
    assert bu100
    for r in bu100:
        entity = r.get("entity")
        if str(entity or "").startswith("BU-"):
            assert entity == "BU-100"
    assert any(str(r.get("entity") or "").startswith("BU-") and r["entity"] != "BU-100" for r in amer)
    assert len(bu100) < len(amer)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("ok")
