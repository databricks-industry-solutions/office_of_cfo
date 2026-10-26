# Ad-hoc inference sample pack

Deterministic workbooks for manual datatype / finance-role inference checks on **Ad-hoc analysis**. Regenerate from the repo root:

```bash
cd app/frontend
npm run samples:adhoc
```

Every file exposes **2026-06** and **2026-09**. Use the stock period picker (**2026-06**, active close) without changing the chrome; **2026-09** remains available for a second pass or multi-month pivot checks.

## Files

| File | Layout | Purpose |
|------|--------|---------|
| `clean-finance-flash.xlsx` | Flat | High-confidence inference on canonical headers |
| `clean-finance-flash.csv` | Flat | Same grid as the clean XLSX (CSV path) |
| `monthly-finance-pivot.xlsx` | Account × month pivot | Period-shaped column headers |
| `messy-finance-flash.xlsx` | Flat | Mixed types, empty cells, currency, slash dates, booleans, invalid amount |

## Expected inference (parse step)

### Flat clean (`clean-finance-flash.xlsx` / `.csv`)

| Column | Data type | Use as | Notes |
|--------|-----------|--------|-------|
| Account | text | metric_id | P&L labels incl. mapped lines |
| Month | date | period | `2026-06` and `2026-09` rows |
| Amt | number | amount | Plain numeric amounts |
| Version | text | version | `Flash` |
| Region | text | ignore | Noise column |
| Notes | text | ignore | Noise column |

**Layout:** `flat`. Three mapped P&L rows plus **Discretionary projects** (unmapped).

### Pivot (`monthly-finance-pivot.xlsx`)

| Column | Data type | Use as | Notes |
|--------|-----------|--------|-------|
| Account | text | metric_id | Row labels |
| 2026-06 / 2026-08 / 2026-09 | number | period | Header supplies month; cells are amounts |
| Version | text | version | `Flash` |

**Layout:** `account_month_pivot`. Includes **Discretionary projects** as an unmapped row.

### Messy flat (`messy-finance-flash.xlsx`)

| Column | Data type | Use as | Notes |
|--------|-----------|--------|-------|
| Account | text | metric_id | |
| Month | date (mixed confidence) | period | `2026-06` rows plus `9/1/26` (Sep) and `2026-09` |
| Amt | text (low confidence) | amount | `$19,110.00`, empty cells, `not posted` |
| Version | boolean | version | `true` / `false` literals |
| Region | text | ignore | Includes empty cells |
| Notes | text | ignore | |

**Run step:** `not posted` should surface as an invalid-value exception when Amount is coerced as number. **Discretionary projects** remains unmapped.
