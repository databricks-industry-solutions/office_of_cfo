# Databricks Solution Accelerator Template - MODIFY THIS README.md

[![Databricks](https://img.shields.io/badge/Databricks-Solution_Accelerator-FF3621?style=for-the-badge&logo=databricks)](https://databricks.com)
[![Unity Catalog](https://img.shields.io/badge/Unity_Catalog-Enabled-00A1C9?style=for-the-badge)](https://docs.databricks.com/en/data-governance/unity-catalog/index.html)
[![Serverless](https://img.shields.io/badge/Serverless-Compute-00C851?style=for-the-badge)](https://docs.databricks.com/en/compute/serverless.html)

## Installation Guidelines

1. Clone the project you'd like to run into your Databricks Workspace

<img width="1726" height="677" alt="Screenshot 2025-07-23 at 11 05 25 AM" src="https://github.com/user-attachments/assets/55b1729f-ad07-420e-a271-843266abfb71" />

2. Open the Asset Bundle Editor in the Databricks UI

<img width="1120" height="665" alt="Screenshot 2025-07-23 at 11 06 12 AM" src="https://github.com/user-attachments/assets/d1f91256-eb8f-4456-8d88-c0a37b1bd4c5" />

3. Click on "Deploy"

<img width="1523" height="902" alt="Screenshot 2025-07-23 at 11 09 37 AM" src="https://github.com/user-attachments/assets/9564cbdd-c5c5-4210-bf27-2b19e6efc85b" />

4. Navigate to the Deployments tab in the Asset Bundle UI (🚀 icon) and click "Run" on the job available. This will run the notebooks from this project sequentially.

<img width="1527" height="880" alt="Screenshot 2025-07-23 at 11 10 13 AM" src="https://github.com/user-attachments/assets/0f612882-7123-449b-8349-1835bc59523c" />

## Roadmap

Approved items and their target quarter. Status as of 2026-10-21; targets are
indicative and may move.

### Delivered

- **Ad-hoc deep analysis**: upload Excel files for analysis in FP&A Performance & Trends.
- **Faster pages**: results are cached after the first load.
- **Genie tab**: Genie has its own tab and supports starting a new chat.

### Q4 2026

| Item | Area | Status |
|---|---|---|
| **AI ROI: Return on Tokens Used (ROTU)**: AI spend by business unit and project from Unity AI Gateway, benefits with evidence levels, break-even and portfolio view | New module | In development |
| **Cash flow forecasting**: driver-based forecast, single currency first | FP&A | In development |
| **Forecast accuracy**: track forecast vs actuals accuracy over time | FP&A | Planned |
| **Connected planning & budgeting**: extend forecast vs actuals into planning and budgets | FP&A | Planned |
| **Architecture diagram** of the solution | Docs | Planned |
| **Minimum data requirements**: the key data needed to power the core features | Docs | Planned |

## Contributing

1. **git clone** this project locally
2. Utilize the Databricks CLI to test your changes against a Databricks workspace of your choice
3. Contribute to repositories with pull requests (PRs), ensuring that you always have a second-party review from a capable teammate


## 📄 Third-Party Package Licenses

&copy; 2025 Databricks, Inc. All rights reserved. The source in this project is provided subject to the Databricks License [https://databricks.com/db-license-source]. All included or referenced third party libraries are subject to the licenses set forth below.

Only dependencies that are **actually distributed** in the published app are listed — the built single-page frontend (`app/frontend/dist/`) and the offline Python wheelhouse (`app/wheels/`). Build- and test-only tooling (Vite, TypeScript, Vitest, Playwright, PostCSS, Autoprefixer) is not shipped and is not listed. Full per-package attribution (version, project URL, copyright) is in [`NOTICE.md`](NOTICE.md).

| Package | License | Copyright |
|---------|---------|-----------|
| FastAPI | MIT | 2018 Sebastián Ramírez |
| Pydantic | MIT | 2017-present Pydantic Services Inc. and contributors |
| Uvicorn | BSD 3-Clause | 2017-present Encode OSS Ltd. |
| python-multipart | Apache 2.0 | 2012 Andrew Dunham |
| Databricks SDK for Python | Apache 2.0 | 2023 Databricks, Inc. |
| psycopg (binary, pool) | LGPL v3.0 &sup1; | 2020 The Psycopg Team |
| React / React DOM | MIT | Meta Platforms, Inc. and affiliates |
| Framer Motion | MIT | 2018 Framer B.V. |
| clsx | MIT | Luke Edwards |
| tailwind-merge | MIT | 2021 Dany Castillo |
| jsPDF | MIT | 2010-2021 James Hall and contributors; yWorks GmbH |
| jspdf-autotable | MIT | 2014 Simon Bengtsson |
| html2canvas | MIT | 2012 Niklas von Hertzen |
| canvg | MIT | 2010 Gabe Lerner and contributors |
| react-force-graph-2d / force-graph | MIT | 2018 Vasco Asturiano |
| d3-force-3d | MIT | 2010-2016 Michael Bostock; Vasco Asturiano |
| d3-sankey | BSD 3-Clause | 2015 Mike Bostock |
| lucide-react | ISC | 2022 Lucide Contributors |
| SheetJS (xlsx) | Apache 2.0 | 2012-present SheetJS LLC |
| DOMPurify | MPL-2.0 OR Apache 2.0 | 2015 Mario Heiderich |

&sup1; psycopg (LGPL v3.0) is distributed unmodified and dynamically linked / imported as a library, satisfying the LGPL distribution conditions. See the LGPL compliance note in [`NOTICE.md`](NOTICE.md).
