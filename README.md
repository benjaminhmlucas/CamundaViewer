# Camunda Viewer

A web-based tool for visualizing Camunda BPMN and DMN diagrams with execution path highlighting, business key header display, and clear variable browsing.

## Features

- **Process & Decision Visualization**: View BPMN diagrams and DMN tables with execution path highlighting
- **Enhanced Rule Tracking**: Captures precise rule IDs using Camunda REST API with includeOutputs=true
- **DMN Input Value Display**: Shows input values used during decision execution with type coloring and sticky headers
- **Variable Browsing**: Ability to browse instance variables for each run
- **Click-to-Deserialize**: On-demand Java object deserialization with loading states and error handling
- **Multi-Environment Support**: Switch between Camunda environments via dropdown
- **Multi-Tab Safe**: Each browser tab uses an isolated session (no cross-talk between tabs)
- **Hierarchical Menu**: Collapsible groups per process type and chronological runs
- **Interactive Navigation**: Pan/zoom, resizable panels, and quick links per process instance
- **File-Based Process History**: Persistent business key history (per environment) with autocomplete
- **Real-time Progress**: Live updates during data fetching
- **Auto-setup**: Creates required directories and handles missing files
- **Session-Based Logging**: Copy/View execution logs per tab session for troubleshooting
- **PII Protection**: Diagram data and variable content are stored in memory only
- **Business Key Display**: Shows current business key in header after successful fetch
- **Smart Shutdown**: Quit button closes all tabs and stops server; automatically shuts down when last tab is closed
- **Tab Management**: Robust automatic tab registration and coordinated shutdown across multiple browser windows with improved timing to prevent premature deregistration

## Installation & Quick Start

### Prerequisites
- Node.js (any recent version)
- PowerShell:
  - **Windows**: built-in
  - **Mac/Linux**: see below
- Access to a Camunda REST API instance

#### Mac/Linux PowerShell Installation
Mac users need PowerShell Core 6+ before running this application:

```bash
# Using Homebrew (recommended)
brew install --cask powershell

# Or download from Microsoft
# https://github.com/PowerShell/PowerShell/releases

pwsh --version  # should be 6.0+
```

### Setup & Launch
1. **Clone repository**: `git clone <repository-url>`
2. **Configure**: Edit `config-local.cfg` with your Camunda server details
3. **Start server**: `npm start`
4. **Open browser**: http://localhost:3000
5. **Use the app**: Select environment, enter business key, click Get Process

Notes:
- Data is kept in memory for PII protection; process history is saved to `process-history.txt`
- Each tab is an isolated session; safe to open multiple tabs/windows

## Usage

1. Select Environment and enter Business Key (autocomplete from history is available)
2. Click Get Process to fetch process instances and diagrams with live progress
3. In the left panel, expand a process type and choose a run (Run 1, Run 2, …)
4. For each run, use links:
   - **[ProcessName] Process ([ordinal] Run)**: open BPMN diagram with execution highlighting
   - **📋 Camunda Objects**: browse simple variables (strings, numbers, booleans)  
   - **🔧 Java Objects**: browse serialized Java variables with click-to-deserialize
   - **🔗 [Decision Name]**: view individual DMN decision tables/scripts with execution timestamps
5. Java Objects behavior:
   - Click a Java variable header to deserialize it on demand
   - A loading indicator appears; once done, the pretty-printed JSON/object type is shown
   - Errors are displayed inline (e.g., connection/auth issues)
6. **Diagram Navigation & Zoom Controls**:
   - **BPMN Processes**: Pan with click and drag; zoom with Ctrl+Mouse wheel
   - **DMN Tables**: Zoom with Ctrl+Mouse wheel; copy table contents using the provided controls
   - **DMN Scripts**: Zoom with Ctrl+Mouse wheel
   - **Reset View**: Use the Reset button to restore original zoom level and recenter the diagram
7. **Logs**: Use 📋 Copy Log / 📄 Open Log for troubleshooting
8. **Quit Application**: Use the quit button to cleanly shut down the server and close all browser tabs

## Configuration

For additional environments, copy `config-[env].cfg.template` to `config-<yourenvironment>.cfg` and fill in:

```cfg
BASE_URL=http://localhost:8080/engine-rest
USERNAME=your-username
PASSWORD=your-password
# Optional proxy settings
PROXY_SERVER=your-proxy-server:port
PROXY_USERNAME=your-proxy-username
PROXY_PASSWORD=your-proxy-password
```

Notes:
- **Local (config-local.cfg)**: HTTP with cross-platform auth handling
  - Other environments can use HTTPS
- **Mac/Linux**: PowerShell Core compatibility supported

## Architecture (High-Level)

```
CamundaViewer/
├── server.js                    – Express server, session management, variable reassembly
├── viewer.html                  – Single-page UI for diagrams and variable interactions  
├── viewer.css                   – Responsive styling with DMN table optimizations
├── package.json                 – Node.js dependencies and npm scripts
├── config-*.cfg                 – Environment configuration files
├── config-[env].cfg.template    – Template for new environment configs
├── process-history.txt          – Persistent business key history (per environment)
├── powershell/
│   ├── GetData.ps1             – Orchestrates Camunda API calls and data chunking
│   └── GetVariableById.ps1     – On-demand Java object deserialization
├── lib/
│   ├── bpmn-viewer.development.js – BPMN diagram rendering library
│   └── dmn-viewer.development.js  – DMN table rendering library
└── images/
    └── exit-door.png           – UI assets
```

## Technical Details

### Data Flow
1. Server discovers `config-*.cfg` files for the environment dropdown via `/config-files`
2. Frontend calls `/fetch-process` (POST) with business key, environment, and session ID
3. Business key is immediately saved to `process-history.txt` for autocomplete
4. Server spawns PowerShell process running `GetData.ps1` with streaming progress
5. PowerShell fetches process instances and limits to latest N runs (configurable `MaxRuns`, default 5)
6. BPMN/DMN files and execution data retrieved with `includeInputs=true` and `includeOutputs=true`
7. Variables are retrieved in chunks via separate API calls to avoid truncation
8. All data (diagrams, execution data, variable chunks) stored in session-scoped server memory
9. Browser loads diagrams via `/diagrams/:filename` and applies execution highlighting
10. `/process-variables` (GET) reassembles variables from chunks on demand for display
11. Current business key stored in session and displayed in header via `/current-process`
12. Java object deserialization happens on-demand via `/deserialize-variable` (POST) per click
13. All endpoints use session validation; frontend automatically adds sessionId parameter

### Variable Data Structure
- Chunks contain `chunkIndex`, `totalChunks`, `variableCount`, `processInstanceId`, `processKey`, and `variables`
- Each variable has `name`, `value`, `type`, and `scope`
- Frontend separates Execution object into two lists:
  - Camunda Objects: shows only simple types (string, number, boolean)
  - Java Objects: shows only serialized Java variables; click to deserialize

### Run Grouping Logic
- Identifies the first process type in chronological order as the run delimiter 
- Groups instances into runs based on occurrences of this first process type
- Only latest N runs are processed (configurable `MaxRuns`, default 5)
- Runs sorted by earliest start time for chronological navigation

## Process History File Format

```
SELECTED=environment

[Dev]
businessKey1
businessKey2

[Test]
businessKey3

[UAT]
businessKey4
businessKey5

[local]
businessKey6
```

## Troubleshooting

- **Environment dropdown shows "Error loading configs"**: Check server console and verify config files exist
- **"Get Process" disabled**: Ensure business key is valid (no empty values)
- **No diagrams after fetch**: "No diagrams available" is normal if no instances exist for that business key
- **500 errors**: Check server console and session logs via "View Logs" button for detailed error information
- **Network/proxy issues**: Add proxy settings to your config file (PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD)
- **Highlighting issues**: Verify process has execution data and process instances were found
- **Slow on large processes**: Increase `MaxRuns` only if needed (higher values increase processing time)
- **Java object won't deserialize**:
  - Check environment credentials and network reachability to Camunda server
  - See browser console and server logs for `/deserialize-variable` errors
- **Multi-tab sessions**: Each tab has an isolated session; if links stop working after long inactivity, refresh the tab to establish a new session. Improved tab timing prevents premature deregistration when opening new tabs.
- **PowerShell errors (Mac/Linux)**: Ensure PowerShell Core 6+ is installed (`pwsh` command available)
- **Config file errors**: Verify config files have BASE_URL, USERNAME, and PASSWORD settings

## Deep Dive

### Concepts
- **Sessions**: Each tab/window uses an isolated session. A sessionId is appended to all requests; if a tab sits idle too long, refresh to establish a new session.
- **Runs**: Process instances are grouped into logical runs using the first process type as delimiter (latest N runs, default 5) for performance and clarity.
- **Variable Separation**: The UI splits variables into two lists to keep the main view fast and readable:
  - Camunda Objects = simple types (string/number/boolean)
  - Java Objects = serialized Java values with on-demand deserialization
- **Variable Chunking**: Variables are processed in chunks of 20 to avoid API response truncation
- **Rate Limiting**: Session-aware rate limiting (200 req/min for fetch-process, 500 req/min for deserialize-variable)

### Enhanced Tab Management
- **Intelligent Registration**: Tab registration timing improved to prevent premature deregistration when opening new browser tabs
- **Coordinated Shutdown**: All tabs communicate through the server to ensure proper cleanup when the last tab is closed
- **Session Isolation**: Each tab maintains independent session data with unique session IDs

### Java Deserialization Flow
- **Trigger**: Click a Java variable header in the Java Objects view
- **Backend**: Calls `/deserialize-variable` which spawns `GetVariableById.ps1` with `-outputJson`
- **UX**: Shows a loading state, then renders pretty-printed JSON and reported object type
- **Errors**: Displayed inline with guidance to check credentials/network

### Performance Considerations
- **Memory Storage**: All data kept in session-scoped server memory (not disk) for PII protection
- **Run Limiting**: MaxRuns parameter controls how many workflow runs to process (default 5)
- **Chunked Processing**: Variables processed in batches to handle large datasets efficiently

### Tips
- Prefer Camunda Objects for quick scanning; use Java Objects only when you need deep inspection
- If links stop responding after long inactivity, refresh the tab to renew the session
- Adjust `MaxRuns` (default 5) if you need older runs, noting higher values increase processing time
- Use "View Logs" button or "Copy Logs" for detailed execution information and troubleshooting

## Security Features for Government Environments

### PII Protection & Data Governance
- **In-Memory Only Storage**: All diagram data, process instances, and variable content stored exclusively in server memory - never written to disk to prevent PII persistence
- **Session-Scoped Data Isolation**: Each browser tab maintains isolated data sessions preventing cross-contamination between users or claims
- **Claim History Limitation**: Only claim IDs (no PII content) stored persistently in `claim-history.txt`
- **No Caching**: No browser or disk caching of sensitive process or variable data

### Credential Security
- **SecureString Password Handling**: PowerShell scripts use `System.Security.SecureString` for credential parameters to prevent plain-text password exposure
- **PSCredential Implementation**: Secure credential object creation for Camunda API authentication
- **No Credential Logging**: Credentials never appear in log files or console output

### Output Sanitization & Information Disclosure Prevention
- **Enhanced stderr Sanitization**: Production mode automatically redacts passwords, API keys, tokens, secrets
- **File Path Redaction**: File paths that might contain usernames or sensitive directory structures are redacted
- **Limited Error Disclosure**: Production stderr output limited to first line only
- **Credential Pattern Matching**: Comprehensive regex patterns to identify and redact sensitive data

### Session Management & Access Control
- **Session ID Validation**: Strict alphanumeric format validation (8-64 characters, no special chars except dash/underscore)
- **Session Isolation**: Complete data separation between browser tabs/windows
- **Session-Aware Rate Limiting**: Per-session rather than per-IP rate limiting to prevent abuse

### Network Security & Rate Limiting
- **Configurable Proxy Support**: Full proxy authentication support for government network environments
- **Endpoint-Specific Rate Limiting**: `/fetch-claim` (200 req/min), `/deserialize-variable` (500 req/min) per session
- **Input Validation**: Claim IDs restricted to numeric-only format to prevent injection attacks
- **Environment Validation**: Restricted environment parameter validation

### Audit & Monitoring
- **Session-Based Logging**: All PowerShell execution captured in session-scoped logs with timestamps
- **Session Tracking**: All requests tagged with sessionId for audit trail
- **Memory Status Monitoring**: Real-time monitoring of in-memory data storage
- **Request Sanitization**: All output sanitized before logging to prevent credential exposure

### Cross-Platform Security
- **PowerShell Executable Detection**: Automatic detection of appropriate PowerShell version (Windows PowerShell vs PowerShell Core)
- **Environment-Specific Configuration**: Isolated configuration files per environment
- **Secure Configuration Loading**: Configuration validation and error handling
