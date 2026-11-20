# Security Policy

## Reporting a Vulnerability

Please email bugbounty@databricks.com to report any security vulnerabilities. We will acknowledge receipt of your vulnerability and strive to send you regular updates about our progress. If you're curious about the status of your disclosure please feel free to email us again. If you want to encrypt your disclosure email, you can use [this PGP key](https://keybase.io/arikfr/key.asc).

## Data Handling

**Synthetic data only.** This is a Databricks reference/demo ("Office of the
CFO"). The repository uses **100% synthetically generated** financial data
(general ledger, subledgers, statements, 24 months of history) matching the
shape of a real month-end close. No actual customer data, PII, or proprietary
information is included. See `NOTICE.md` for how the data is produced.

When deployed to your workspace the app connects to real Databricks resources
(Unity Catalog schemas, a Lakebase Autoscaling project with one Postgres
database per industry, Genie spaces, a SQL warehouse). Security practices for
anything you point it at are your responsibility — see **Access Control** and
**Known Limitations** below.

## Environment Variables & Secrets Management

All sensitive configuration is environment-variable / OAuth driven.
**Never commit secrets** (PATs, database passwords, tokens) to the repository.

- **Local development** uses your Databricks CLI profile — no tokens stored in
  the repo. Non-secret runtime config (catalog, warehouse id, Genie space ids)
  lives in `app/app.yaml` / `config/demo.yaml`.
- **Deployed on Databricks Apps** the app runs as a **service principal**.
  It reaches the Lakebase project by name (`LAKEBASE_PROJECT`, one database per
  industry) and mints a fresh OAuth database credential for each connection as
  that service principal (no `PGUSER`/`PGPASSWORD` pinned in config). The SP's
  own credentials are provided by the Apps platform at deploy time; app code
  never reads them from source or filesystem.

## Access Control

The app implements a **persona + scope** model:

- Databricks Apps signs viewers in (workspace SSO) and only lets users with
  `CAN USE` on the app open it, but the app does **not** act on that identity.
  Warehouse and Lakebase reads and writes run as the app service principal, and
  actions are attributed to the selected persona, not the signed-in user. The
  only exception is Genie: calls first use the viewer's forwarded token and fall
  back to the service principal when that token lacks Genie scope.
- The persona comes from an `X-Persona` request header set by the "view as"
  switcher; the server checks that it is a known persona, not who sent it.
- Three personas — **CFO** (consolidated, read-only), **Controller** (a
  geography or business line), **Accountant** (transactional workbench) — change
  navigation and data scope.
- Scope resolves against the org hierarchy (Region → Country → Legal Entity →
  Business Unit, crossed with Business Line); every read filters to it.
- Each industry has its own Unity Catalog schema set and its own Postgres
  database in the shared Lakebase project; the app SP must hold `CAN RUN` on
  the relevant Genie spaces.

**For production:** enforce this at the data layer — Unity Catalog fine-grained
access control and/or row-level security in Lakebase — rather than trusting the
application-layer persona switch.

## Known Limitations

1. **Persona scoping is application-layer, not row-level secure.** The "view as"
   switcher is a demo affordance. Enforce visibility with UC RLS / column masks
   or SQL-level RLS for real data.
2. **Adjustments are stored in Lakebase without full audit logging.** For
   compliance-sensitive use, add Databricks audit logs or Delta change feed
   tracking.
3. **Genie spaces use default permissions.** Configure space membership to
   control who can access the AI chat surfaces in a real deployment.
4. **AI Functions run on shared model endpoints.** `ai_query`/`ai_extract` calls
   (databricks-claude-sonnet-4-5) send the constructed prompt (synthetic figures)
   to the serving endpoint; review data-egress rules before pointing at real data.
5. **No credential rotation.** Genie space ids / warehouse id in config are
   static demo values; manage real credentials via SP OAuth and rotate
   periodically.
6. **`POST /api/demo/reset` has no authorization check.** Anyone who can open
   the app can call it, whatever their persona. It deletes app- and
   reset-posted adjustments for the close period from the lake
   `posted_adjustments` table, injects the next demo scenario and re-seeds the
   Approvals queue in Lakebase for the active industry. Remove or gate this
   route before pointing the app at real data.
7. **Benchmarking sends a contact email to SEC EDGAR.** Peer lookups call
   `sec.gov` / `data.sec.gov` (and `filings.xbrl.org`) with a User-Agent that
   includes `CFO_CONTACT_EMAIL`, as SEC's fair-access policy requires. The
   bundle defaults it to the deploying user's email, so that address leaves the
   workspace with every lookup. Set `contact_email` to a shared or team
   address if that is not acceptable.

## Security Review Checklist for Customization

When adapting this demo for your organization, review:

- [ ] Authentication: is OAuth/SSO configured for your workspace?
- [ ] Data access: are persona/region scopes enforced at the database level, not
      just in the app?
- [ ] Secrets: are all tokens, DB passwords, and SP keys in Databricks secret
      scopes or SP OAuth — never in source?
- [ ] Logging: is audit trail enabled in the workspace and Lakebase?
- [ ] AI: are Genie space membership and model-endpoint egress rules appropriate
      for the data you connect?
- [ ] Compliance: does the deployment meet your data residency, encryption, and
      retention policies?

---

**Last updated:** 2026-11-20
