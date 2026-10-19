Copyright (2025) Databricks, Inc.

This Software includes software developed at Databricks (https://www.databricks.com/) and its use is subject to the included LICENSE file.
By using this repository and the notebooks within, you consent to Databricks collection and use of usage and tracking information in accordance with our privacy policy at www.databricks/privacypolicy.

Dependencies are grouped below by license. The full text of each license is available via the link in the section header.

Scope: this file attributes the open-source dependencies that are actually
distributed in the published Databricks App — the built single-page frontend
(committed under `app/frontend/dist/`) and the offline Python wheelhouse
(committed under `app/wheels/`, installed at deploy time). Build- and test-only
tooling (Vite, TypeScript, Vitest, Playwright, PostCSS, Autoprefixer, type
stubs) is not shipped in either artifact and is therefore not listed. The
authoritative, fully pinned lists are `app/uv.lock` and
`app/frontend/package-lock.json`.

MIT License
This Software contains code from the following open source projects, licensed under the MIT license (https://opensource.org/licenses/MIT).

Package: FastAPI
Version: 0.138.0
Project URL: https://github.com/fastapi/fastapi
Copyright: 2018 Sebastián Ramírez

Package: Pydantic
Version: 2.13.4
Project URL: https://github.com/pydantic/pydantic
Copyright: 2017-present Pydantic Services Inc. and contributors

Package: React
Version: 18.3.1
Project URL: https://github.com/facebook/react
Copyright: Meta Platforms, Inc. and affiliates

Package: React DOM
Version: 18.3.1
Project URL: https://github.com/facebook/react
Copyright: Meta Platforms, Inc. and affiliates

Package: Framer Motion
Version: 12.42.0
Project URL: https://github.com/motiondivision/motion
Copyright: 2018 Framer B.V.

Package: clsx
Version: 2.1.1
Project URL: https://github.com/lukeed/clsx
Copyright: Luke Edwards

Package: tailwind-merge
Version: 3.6.0
Project URL: https://github.com/dcastil/tailwind-merge
Copyright: 2021 Dany Castillo

Package: jsPDF
Version: 4.2.1
Project URL: https://github.com/parallax/jsPDF
Copyright: 2010-2021 James Hall and contributors; yWorks GmbH

Package: jspdf-autotable
Version: 5.0.8
Project URL: https://github.com/simonbengtsson/jsPDF-AutoTable
Copyright: 2014 Simon Bengtsson

Package: html2canvas
Version: 1.4.1
Project URL: https://github.com/niklasvh/html2canvas
Copyright: 2012 Niklas von Hertzen

Package: canvg
Version: 3.0.11
Project URL: https://github.com/canvg/canvg
Copyright: 2010 Gabe Lerner and contributors

Package: react-force-graph-2d
Version: 1.29.1
Project URL: https://github.com/vasturiano/react-force-graph
Copyright: 2018 Vasco Asturiano

Package: force-graph
Version: 1.51.4
Project URL: https://github.com/vasturiano/force-graph
Copyright: 2018 Vasco Asturiano

Package: d3-force-3d
Version: 3.0.6
Project URL: https://github.com/vasturiano/d3-force-3d
Copyright: 2010-2016 Michael Bostock; Vasco Asturiano

Apache License 2.0
This Software contains code from the following open source projects, licensed under the Apache License 2.0 license (https://www.apache.org/licenses/LICENSE-2.0).

Package: Databricks SDK for Python
Version: 0.119.0
Project URL: https://github.com/databricks/databricks-sdk-py
Copyright: 2023 Databricks, Inc.

Package: python-multipart
Version: 0.0.32
Project URL: https://github.com/Kludex/python-multipart
Copyright: 2012 Andrew Dunham

Package: SheetJS (xlsx)
Version: 0.18.5
Project URL: https://github.com/SheetJS/sheetjs
Copyright: 2012-present SheetJS LLC

BSD 3-Clause License
This Software contains code from the following open source projects, licensed under the BSD 3-Clause license (https://opensource.org/license/bsd-3-clause).

Package: Uvicorn
Version: 0.49.0
Project URL: https://github.com/encode/uvicorn
Copyright: 2017-present Encode OSS Ltd.

Package: d3-sankey
Version: 0.12.3
Project URL: https://github.com/d3/d3-sankey
Copyright: 2015 Mike Bostock

ISC License
This Software contains code from the following open source projects, licensed under the ISC license (https://opensource.org/license/isc-license-txt).

Package: lucide-react
Version: 1.21.0
Project URL: https://github.com/lucide-icons/lucide
Copyright: 2022 Lucide Contributors

Mozilla Public License 2.0 OR Apache License 2.0
This Software contains code from the following open source project, dual-licensed under MPL-2.0 (https://www.mozilla.org/en-US/MPL/2.0/) OR the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

Package: DOMPurify
Version: 3.4.12
Project URL: https://github.com/cure53/DOMPurify
Copyright: 2015 Mario Heiderich

GNU Lesser General Public License v3.0
This Software contains code from the following open source project, licensed under the GNU Lesser General Public License v3.0 license (https://www.gnu.org/licenses/lgpl-3.0.en.html).

Package: psycopg (installed with the "binary" and "pool" extras: psycopg, psycopg-binary, psycopg-pool)
Version: 3.3.4
Project URL: https://github.com/psycopg/psycopg
Copyright: 2020 The Psycopg Team

LGPL compliance note: psycopg is distributed unmodified (used as-is) and is
dynamically linked / imported as a library by this application's proprietary
code. It is not statically combined into, and its source is not modified by,
this project. These conditions satisfy the LGPL v3.0 terms for distribution.
The complete corresponding license text is available at the Project URL above.

Vendored wheelhouse: `app/wheels/` additionally contains the transitive Python
dependencies of the packages above (e.g. Starlette, anyio, h11, certifi,
urllib3, requests, google-auth, cryptography, protobuf, typing-extensions).
Each remains under its own license as declared in its package metadata; the
authoritative pinned list is `app/uv.lock`.

Data: all data in this repository is 100% synthetic (no customer data, PII, or
proprietary information) and is generated procedurally by the code under
`data_generation/`. No external datasets are bundled. Competitor benchmarking
retrieves public regulatory filings (SEC EDGAR / ESEF XBRL) at runtime; these
public disclosures are not redistributed in this repository.
