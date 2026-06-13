# REQ Wrangler: Space Instrument Compliance & Requirements Manager

REQ Wrangler is a high-fidelity, client-side web application designed to track compliance matrices, verification gaps, and test execution backlogs.

It is built entirely on client-side technologies, allowing it to run completely offline via the `file://` protocol directly from a local `index.html` file, with persistent database storage saved directly to the browser's `localStorage`.

---

## 🌟 Core Features

### 1. Executive Dashboard
- **Rollup Statistics**: Real-time compliance gauges, total requirement satisfaction percentages, test log summaries, and total execution estimates.
- **Program Compliance Summary**: High-level visual indicators showing the breakdown of requirements (Passed, In Progress, Not Started) for each active spacecraft program.

### 2. Planning Desk & Gap Analysis
- **Untested Gaps**: Lists all requirements that lack associated verification tests, warning you of coverage holes.
- **Verification Backlog**: Displays tests that are planned but not yet written, with drag-estimations and developer assignment.
- **Sprint Estimator**: Summarizes overall backlog days remaining and developer workloads.

### 3. Flight Program Matrix
- **Program Matrix Table**: Details compliance levels for selected programs (e.g. SABER Sounding, OPIR Payload, WISDOM Calibration).
- **PDF Report Exporter**: Generates a print-ready, professional compliance report page.
- **Document Exporters**:
  - **Export MD**: Generates a structured Markdown `.md` status report of requirements and test matrices.
  - **Export CSV**: Downloads requirement spreadsheets ready for Excel, with full metadata escaping.

### 4. Shared Capabilities Matrix
- **Inheritance Mapping**: Capabilities link to requirements across multiple programs. When a capability passes in one program, it automatically inherits this status to other programs' linked requirements, dramatically saving verification test cycles.
- **Inline Requirement Builder**: Allows adding requirements directly from the Capability row for unlinked capabilities.

### 5. Verification Test Log & Drag Reordering
- **Subtask Rollups**: Automated test status calculation from subtask components.
- **Execution Dates**: Records and displays the exact date stamps when tests transition to `Passed`.
- **Drag-and-Drop Priority**: First column displays test execution priority. Click, drag, and drop rows to reorder tests in the queue and immediately adjust priority indices.

### 6. Interactive Traceability Graph (Visual Network)
- **Interactive Map**: Displays a 3-column interactive SVG flow graph mapping **Capabilities ➔ Requirements ➔ Verification Tests**.
- **Marching Ants Animation**: Hovering over any card node activates a thick, animated glowing path connecting the compliance trace, while dimming unrelated elements.
- **Drill-Down Modals**: Click on any card node to open details, change statuses, and update the graph in real-time.
- **Auto-Resize**: Recalculates exact bounding port coordinates when browser window sizes shift.

### 7. Centralized System Settings
- **Safe Data Management**: Moves administrative controls (**Export JSON State**, **Import JSON State**, and **Reset Mock Data**) out of the sidebar footer into a single settings modal.
- **Configuration Panels**: Centralizes lists to add/remove **Test Types**, **Component Codes**, and **Team Members**.

---

## 🛠️ Architecture & Technology Stack

- **Structure**: Semantic HTML5 layout.
- **Styling**: Vanilla CSS3 using variable design tokens for theme handling, depth shadows, card transitions, and custom animations.
- **Logic**: Vanilla ES6 JavaScript (separated into data structures/logic in [data.js](file:///c:/Users/oacom/Documents/AI_Code/requirementWrangler/data.js) and DOM controller in [app.js](file:///c:/Users/oacom/Documents/AI_Code/requirementWrangler/app.js)).
- **Database**: Saved as serialized JSON in the browser's `localStorage`.
- **External Dependencies**:
  - **Google Fonts**: Outfit (headings) and Inter (body).
  - **SheetJS (XLSX)**: Loaded via CDN for client-side Excel spreadsheet importing.

---

## 🚀 Getting Started

No compilers, local servers, or package installations are required!

1. Clone or download this repository folder.
2. Locate `index.html` in the root folder.
3. Double-click `index.html` to open it in any modern web browser.
4. Click the **💡 Guided Tour** button in the header bar for an interactive overview of the workspace.

---

## 📁 Importing Excel Data

Two template spreadsheets are provided in the root directory:
- `capabilities_import.xlsx` (use to batch import shared capabilities)
- `saber_requirements_import.xlsx` (use to batch import requirements mapped to specific programs)

To import:
1. Open **Settings & Data** (bottom left sidebar).
2. Click **Import State JSON** to upload a full database, or use the **Import from Excel** buttons in the respective views (e.g., in Requirements tab).
3. Select your `.xlsx` file and map the table columns in the modal to confirm import.
