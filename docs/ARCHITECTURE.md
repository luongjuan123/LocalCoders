# LocalCoders Architecture & Engineering Specification

## 1. Executive Summary

**LocalCoders** is designed to provide a cohesive, AI-native desktop IDE experience comparable to **Google Antigravity IDE**, **Cursor**, and **Windsurf**, powered 100% locally by **Ollama**.

Instead of treating AI as an external chatbot or a simple single-turn text auto-complete plugin, LocalCoders implements an autonomous multi-agent software engineering team inside the desktop workbench.

---

## 2. Workbench Layout (Antigravity & VS Code-Inspired)

The IDE workbench consists of five synchronized regions:

1. **TitleBar**:
   - Project directory switcher.
   - Real-time agent status pill (`idle`, `planning`, `working`, `reviewing`, `delegating`).
   - Active Ollama model indicator.
2. **Activity Bar** (Left vertical strip):
   - File Explorer
   - Global Search
   - Git Source Control
   - Multi-Agent Team Configuration
   - Ollama Model Manager
   - Project Rules & Conventions
   - Bottom Panel toggle & AI Sidebar toggle
3. **Left Sidebar**:
   - Directory tree with recursive file navigation.
   - Model browser with parameter counts, quantizations, and hardware RAM requirements.
   - Interactive agent team roster.
4. **Editor Area** (Center):
   - Multiple open tabs.
   - Monaco Editor instance with full syntax highlighting.
   - Side-by-side Monaco DiffEditor for reviewing agent code modifications before committing.
   - Unsaved indicator & `Ctrl+S` keyboard shortcuts.
5. **Multi-Agent AI Control Panel** (Right):
   - Operational modes: `Agent` (full autonomy), `Plan` (architectural outline only), `Ask` (consultation), `Review` (code audit).
   - Real-time streaming conversation transcript with agent thinking blocks.
   - **Live Task Plan Checklist** with progress states (`pending`, `in_progress`, `completed`, `failed`).
   - **Human-in-the-Loop Approval Cards** for destructive operations or risky git commands.
6. **Bottom Panel**:
   - **Terminal**: Embedded interactive shell runner with real-time output.
   - **Critic Reports**: Categorized findings with severity badges (`Critical`, `High`, `Medium`, `Low`, `Informational`), line numbers, evidence, and one-click "Ask Main Agent to Fix This" action buttons.
   - **Agent Execution Logs**: Raw multi-agent activity stream and telemetry.

---

## 3. Multi-Agent Coordination Protocol

### A. Mandatory Main Agent
The Main Agent is the coordinator of every user interaction.
- **Context Synthesis**: Ingests workspace tree, `.localcoders/rules.md`, and relevant files.
- **Planning**: Generates a structured JSON plan breaking down the user goal into discrete tasks.
- **Delegation**: Identifies tasks suitable for specialized Subagents or executes them directly.
- **Tool Calling**: Invokes filesystem, search, git, and execution tools within strict workspace boundaries.

### B. Specialized Subagents
Users configure zero or more subagents tailored to their stack. Roles include:
- `Frontend Developer`: React, Vue, CSS, UI components, accessibility.
- `Backend Developer`: Node.js, Python, REST APIs, databases.
- `Database Engineer`: Schema design, migrations, SQL optimization.
- `Software Architect`: System design, modularity, patterns.
- `Debugging Specialist`: Root cause analysis, stack trace inspection.
- `Test Engineer`: Unit tests, integration tests, mock generators.
- `Security Auditor`: OWASP vulnerabilities, input sanitization, auth checks.
- `Performance Engineer`: Profiling, memory leaks, algorithmic complexity.
- `Documentation Writer`: READMEs, API specifications, docstrings.
- `Research Agent`: Background technology evaluation.

### C. Independent Critic Agent
The Critic Agent operates autonomously from the Main Agent to prevent "confirmation bias":
- Uses reasoning-focused models (e.g. `deepseek-r1:8b`).
- Reviews `git diff` and modified files against requirements and project rules.
- Flags defects across 12 categories: Logical correctness, Security, Auth, SQL injection, XSS, Race conditions, Memory leaks, Performance, Architecture, Error handling, Test coverage, and Requirement violations.
- Outputs structured findings with severity levels and reproducible evidence.
- Automatically triggers a **Targeted Correction Cycle** if `Critical` or `High` severity defects are flagged.

---

## 4. Concurrency & Conflict Prevention

To allow multiple agents to work concurrently without corrupting project files:
1. **FileLockManager**:
   - Agents must acquire a file mutex lock before writing or editing any file.
   - If another agent holds the lock, the requesting agent queues until the lock is released.
   - Locks are released immediately upon subtask completion.
2. **Automatic Safe Checkpoints**:
   - Prior to executing any multi-agent plan, the tool manager creates a temporary Git stash checkpoint (`create_checkpoint`).
   - Enables instantaneous rollback if a task fails or is cancelled by the user.

---

## 5. Security & Boundary Enforcement

- **Strict Path Sandboxing**: All file tools enforce that resolved paths reside inside `workspaceRoot`. Directory traversal attempts (e.g. `../../etc/passwd`) are rejected with explicit security errors.
- **Approval Gate**: Commands marked destructive (e.g. `revert_file`, `delete_file`, or arbitrary shell execution) emit an IPC approval request and halt execution until the user clicks **Approve** in the UI.
- **Non-Privileged Electron Execution**: Launcher runs Electron with isolated contexts, disallowing arbitrary Node.js execution in renderer processes.
