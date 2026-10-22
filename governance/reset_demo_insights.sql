-- Demo reset — restore the ZeroOps "Approve repair" items (Act 2).
--
-- After a demo, the approved insights stay APPROVED (they persist to the shared
-- Unity Catalog table). Run this before the next run to put them back to a clean
-- demo-ready state: the schema-drift signal stays auto-healed (RESOLVED); every
-- other signal returns to PROPOSED with its approver cleared, so the Controller
-- has repairs to approve on stage again.
--
-- Run it with governance/reset_demo_insights.py, which fills {{ops}} per industry.
UPDATE {{ops}}.zeroops_insights
SET status   = CASE WHEN signal_type = 'schema_evolution' THEN 'RESOLVED' ELSE 'PROPOSED' END,
    approver = CASE WHEN signal_type = 'schema_evolution' THEN approver ELSE NULL END
WHERE period = '2026-06';
