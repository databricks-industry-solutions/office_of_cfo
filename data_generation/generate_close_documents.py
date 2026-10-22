"""Generate synthetic unstructured documents for the Close Support / IDP module.

Two document types, both vertical-neutral and deterministic (seed=42):

  filings/   competitor annual-report style PDFs with an MD&A narrative + a KPI
             table (revenue, margins, DSO/DPO/DIO/CCC). Values are hand-seeded so
             the benchmark deltas vs our own `working_capital_kpis` are interesting.
  contracts/ vendor / customer contracts with term + renewal dates, payment terms,
             auto-renewal, liability caps and 1-2 seeded "risk" clauses (imminent
             auto-renewal, uncapped liability) so the obligations table has red flags.

Everything is written locally (no Databricks dependency here). `load_documents.py`
uploads the PDFs + manifest to the UC Volume under the baseline_raw schema.
An offline pass (`close_support/build_close_support.py`) then parses + extracts them
with Databricks AI functions into governed tables the app reads.

Run:  uv run --with reportlab python generate_close_documents.py
"""
from __future__ import annotations

import json
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from _common import CLOSE_PERIOD, OUTPUT_DIR

DOCS_OUT = OUTPUT_DIR / "documents"
FILINGS_OUT = DOCS_OUT / "filings"
CONTRACTS_OUT = DOCS_OUT / "contracts"

FISCAL_YEAR = CLOSE_PERIOD[:4]  # "2026"

# ---------------------------------------------------------------------------
# Competitor filings — fictional peers of "Northwind". KPI values are seeded so
# the benchmark story is mixed (some peers better, some worse than us). Revenue
# is annual ($B); working-capital metrics are in days; margins in percent.
# ---------------------------------------------------------------------------
COMPETITORS = [
    {
        "company": "Vireo Industrial Group",
        "ticker": "VIG",
        "revenue_b": 11.2, "gross_margin": 38.0, "operating_margin": 14.5, "net_margin": 9.2,
        "dso": 42, "dio": 24, "dpo": 25, "ccc": 41, "growth_yoy": 6.1,
        "narrative": (
            "Fiscal {yr} revenue grew 6.1% to $11.2 billion, led by the Industrial "
            "Components segment. Management continues to prioritize margin discipline; "
            "however, elevated receivables extended days sales outstanding to 42 days, "
            "and working capital remained a headwind as the cash conversion cycle widened "
            "to 41 days. The Board reaffirmed its capital-return program."
        ),
    },
    {
        "company": "Halden Manufacturing Co.",
        "ticker": "HMC",
        "revenue_b": 6.8, "gross_margin": 41.5, "operating_margin": 16.0, "net_margin": 11.0,
        "dso": 34, "dio": 17, "dpo": 44, "ccc": 7, "growth_yoy": 10.4,
        "narrative": (
            "Halden delivered a strong close to fiscal {yr}, with net revenue of $6.8 "
            "billion and continued expansion of gross margin to 41.5%. Disciplined "
            "supplier terms lifted days payable outstanding to 44 days and compressed the "
            "cash conversion cycle to 7 days, among the best in the peer set. Free cash "
            "flow conversion exceeded 95% of net income."
        ),
    },
    {
        "company": "Orable Systems Inc.",
        "ticker": "ORB",
        "revenue_b": 4.1, "gross_margin": 58.0, "operating_margin": 22.0, "net_margin": 15.5,
        "dso": 27, "dio": 6, "dpo": 33, "ccc": 0, "growth_yoy": 24.5,
        "narrative": (
            "Orable Systems reported fiscal {yr} revenue of $4.1 billion at a 58.0% gross "
            "margin, reflecting its asset-light, services-weighted model. Minimal "
            "inventory (days inventory outstanding of 6 days) and efficient collections "
            "drove a cash conversion cycle of effectively zero days. Deferred revenue "
            "growth remained the primary working-capital tailwind."
        ),
    },
    {
        "company": "Continental Foods PLC",
        "ticker": "CFP",
        "revenue_b": 15.6, "gross_margin": 29.0, "operating_margin": 9.5, "net_margin": 6.0,
        "dso": 51, "dio": 33, "dpo": 46, "ccc": 38, "growth_yoy": 3.2,
        "narrative": (
            "Continental Foods generated fiscal {yr} revenue of $15.6 billion across its "
            "consumer and food-service channels. Margins remained pressured by input-cost "
            "inflation, with gross margin of 29.0%. Inventory build ahead of seasonal "
            "demand pushed days inventory outstanding to 33 days and the cash conversion "
            "cycle to 38 days; management targets a return to the low-30s next year."
        ),
    },
]

# ---------------------------------------------------------------------------
# Contracts — vendor / customer agreements. Two seeded risks:
#   - Northstar Cloud Services: auto-renews 2026-07-15 (inside the close window),
#     90-day non-renewal notice already lapsed -> HIGH.
#   - Anderson & Cole LLP: liability is UNCAPPED -> HIGH.
# ---------------------------------------------------------------------------
CLOSE_END = date(int(FISCAL_YEAR), int(CLOSE_PERIOD[5:7]), 30)

CONTRACTS = [
    {
        "contract_id": "MSA-2024-0417",
        "counterparty": "Northstar Cloud Services, Inc.",
        "party_type": "vendor",
        "category": "SaaS / Cloud infrastructure",
        "effective": "2024-07-16", "term_end": "2026-07-15",
        "renewal_date": "2026-07-15", "auto_renew": True, "notice_days": 90,
        "payment_terms": "Net 30", "annual_value": 1_450_000, "currency": "USD",
        "liability_cap": "12 months of fees",
        "obligations": [
            "Auto-renews for a successive 12-month term on 2026-07-15 unless written notice is given at least 90 days prior.",
            "Customer commits to a minimum annual spend of $1,450,000 (Net 30).",
            "Liability capped at trailing 12 months of fees; excludes data-breach indemnity.",
        ],
        "risk_level": "HIGH",
        "risk_note": "Auto-renewal date (2026-07-15) falls inside the close window and the 90-day non-renewal notice has already lapsed.",
    },
    {
        "contract_id": "MSA-2023-1188",
        "counterparty": "Meridian Logistics LLC",
        "party_type": "vendor",
        "category": "Freight & logistics",
        "effective": "2023-10-01", "term_end": "2026-09-30",
        "renewal_date": "2026-09-30", "auto_renew": False, "notice_days": 60,
        "payment_terms": "Net 45", "annual_value": 2_300_000, "currency": "USD",
        "liability_cap": "$5,000,000 aggregate",
        "obligations": [
            "Fixed-rate freight schedule through 2026-09-30; renewal by mutual written agreement only.",
            "Volume rebate of 3% on annual spend above $2,000,000.",
            "Aggregate liability capped at $5,000,000; force-majeure carve-out for port closures.",
        ],
        "risk_level": "MEDIUM",
        "risk_note": "Renewal requires renegotiation within 60 days of term end; rate exposure if freight indices rise.",
    },
    {
        "contract_id": "SLA-2025-0042",
        "counterparty": "Anderson & Cole LLP",
        "party_type": "vendor",
        "category": "Professional / legal services",
        "effective": "2025-01-01", "term_end": "2026-12-31",
        "renewal_date": "2026-12-31", "auto_renew": False, "notice_days": 30,
        "payment_terms": "Net 60", "annual_value": 780_000, "currency": "USD",
        "liability_cap": "UNCAPPED",
        "obligations": [
            "Hourly engagement with a not-to-exceed of $780,000 per annum.",
            "Professional liability is UNCAPPED under Section 9.2 (no limitation of liability).",
            "Either party may terminate for convenience on 30 days written notice.",
        ],
        "risk_level": "HIGH",
        "risk_note": "Section 9.2 leaves professional liability uncapped — a material financial-exposure risk.",
    },
    {
        "contract_id": "CSA-2024-0910",
        "counterparty": "Grofield Retail Group",
        "party_type": "customer",
        "category": "Master customer supply agreement",
        "effective": "2024-04-01", "term_end": "2027-03-31",
        "renewal_date": "2027-03-31", "auto_renew": True, "notice_days": 120,
        "payment_terms": "Net 60", "annual_value": 6_900_000, "currency": "USD",
        "liability_cap": "$10,000,000 aggregate",
        "obligations": [
            "Committed customer volume of $6,900,000 per annum through 2027-03-31 (Net 60).",
            "Auto-renews for 24 months unless either party gives 120 days notice.",
            "Most-favored-pricing clause: customer entitled to lowest published tier.",
        ],
        "risk_level": "LOW",
        "risk_note": "Long-dated, healthy customer commitment; Net 60 terms modestly extend DSO.",
    },
]


def _styles():
    ss = getSampleStyleSheet()
    ss.add(ParagraphStyle(name="Body", parent=ss["Normal"], fontName="Helvetica",
                          fontSize=10, leading=15, alignment=TA_JUSTIFY, spaceAfter=8))
    ss.add(ParagraphStyle(name="H1", parent=ss["Title"], fontName="Helvetica-Bold",
                          fontSize=18, spaceAfter=6))
    ss.add(ParagraphStyle(name="H2", parent=ss["Heading2"], fontName="Helvetica-Bold",
                          fontSize=12, spaceBefore=10, spaceAfter=6))
    ss.add(ParagraphStyle(name="Muted", parent=ss["Normal"], fontName="Helvetica",
                          fontSize=8, textColor=colors.grey, spaceAfter=2))
    return ss


def _kpi_table(c: dict, ss) -> Table:
    rows = [
        ["Metric", "FY" + FISCAL_YEAR, "Unit"],
        ["Total revenue", f"${c['revenue_b']:.1f}", "$B"],
        ["Revenue growth (YoY)", f"{c['growth_yoy']:.1f}", "%"],
        ["Gross margin", f"{c['gross_margin']:.1f}", "%"],
        ["Operating margin", f"{c['operating_margin']:.1f}", "%"],
        ["Net margin", f"{c['net_margin']:.1f}", "%"],
        ["Days sales outstanding (DSO)", f"{c['dso']}", "days"],
        ["Days inventory outstanding (DIO)", f"{c['dio']}", "days"],
        ["Days payable outstanding (DPO)", f"{c['dpo']}", "days"],
        ["Cash conversion cycle (CCC)", f"{c['ccc']}", "days"],
    ]
    t = Table(rows, colWidths=[3.2 * inch, 1.3 * inch, 0.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A1F28")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9ced6")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f4f7")]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def build_filing(c: dict, ss) -> str:
    fname = f"{c['ticker']}_FY{FISCAL_YEAR}_annual_report.pdf"
    path = FILINGS_OUT / fname
    doc = SimpleDocTemplate(str(path), pagesize=LETTER,
                            topMargin=0.8 * inch, bottomMargin=0.8 * inch,
                            leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                            title=f"{c['company']} FY{FISCAL_YEAR} Annual Report")
    story = [
        Paragraph(f"{c['company']} ({c['ticker']})", ss["H1"]),
        Paragraph(f"Fiscal Year {FISCAL_YEAR} Annual Report &mdash; Form 10-K (excerpt)", ss["Muted"]),
        Spacer(1, 10),
        Paragraph("Management's Discussion and Analysis", ss["H2"]),
        Paragraph(c["narrative"].format(yr=FISCAL_YEAR), ss["Body"]),
        Spacer(1, 8),
        Paragraph("Selected Financial and Operating Metrics", ss["H2"]),
        _kpi_table(c, ss),
        Spacer(1, 8),
        Paragraph(
            "The metrics above are presented for benchmarking purposes and are derived "
            "from the audited consolidated financial statements. Working-capital metrics "
            "are computed on a trailing basis consistent with prior periods.", ss["Body"]),
    ]
    doc.build(story)
    return fname


def build_contract(k: dict, ss) -> str:
    fname = f"{k['contract_id']}_{k['counterparty'].split()[0]}.pdf"
    path = CONTRACTS_OUT / fname
    doc = SimpleDocTemplate(str(path), pagesize=LETTER,
                            topMargin=0.8 * inch, bottomMargin=0.8 * inch,
                            leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                            title=f"{k['contract_id']} — {k['counterparty']}")
    meta = [
        ["Contract ID", k["contract_id"]],
        ["Counterparty", k["counterparty"]],
        ["Type", k["party_type"].title() + " — " + k["category"]],
        ["Effective date", k["effective"]],
        ["Term end", k["term_end"]],
        ["Renewal date", k["renewal_date"]],
        ["Auto-renew", "Yes" if k["auto_renew"] else "No"],
        ["Non-renewal notice", f"{k['notice_days']} days"],
        ["Payment terms", k["payment_terms"]],
        ["Annual value", f"${k['annual_value']:,.0f} {k['currency']}"],
        ["Limitation of liability", k["liability_cap"]],
    ]
    mt = Table(meta, colWidths=[2.2 * inch, 4.0 * inch])
    mt.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9ced6")),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#f2f4f7")]),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story = [
        Paragraph("Master Agreement", ss["H1"]),
        Paragraph(f"{k['contract_id']} &mdash; {k['counterparty']}", ss["Muted"]),
        Spacer(1, 10),
        Paragraph("1. Key Terms", ss["H2"]),
        mt,
        Spacer(1, 10),
        Paragraph("2. Obligations and Key Clauses", ss["H2"]),
    ]
    for i, o in enumerate(k["obligations"], 1):
        story.append(Paragraph(f"2.{i} &nbsp; {o}", ss["Body"]))
    story += [
        Spacer(1, 8),
        Paragraph("3. Term and Renewal", ss["H2"]),
        Paragraph(
            f"This Agreement commences on {k['effective']} and continues through "
            f"{k['term_end']} (the &ldquo;Initial Term&rdquo;). "
            + ("Upon expiry the Agreement automatically renews unless a party provides "
               f"written notice of non-renewal at least {k['notice_days']} days before the "
               f"renewal date of {k['renewal_date']}."
               if k["auto_renew"]
               else "The Agreement does not automatically renew; any extension requires a "
               "mutually executed amendment."),
            ss["Body"]),
    ]
    doc.build(story)
    return fname


def main():
    for d in (FILINGS_OUT, CONTRACTS_OUT):
        d.mkdir(parents=True, exist_ok=True)
    ss = _styles()

    manifest = []
    print("Competitor filings:")
    for c in COMPETITORS:
        fname = build_filing(c, ss)
        manifest.append({
            "filename": fname, "doc_type": "filing", "counterparty": c["company"],
            "period": f"FY{FISCAL_YEAR}", "folder": "filings",
        })
        print(f"  {fname}")

    print("Contracts:")
    for k in CONTRACTS:
        fname = build_contract(k, ss)
        manifest.append({
            "filename": fname, "doc_type": "contract", "counterparty": k["counterparty"],
            "period": k["term_end"], "folder": "contracts",
        })
        print(f"  {fname}")

    (DOCS_OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote {len(manifest)} documents + manifest.json to {DOCS_OUT}")


if __name__ == "__main__":
    main()
