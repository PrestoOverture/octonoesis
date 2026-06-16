# Octonoesis 🐙

An open-source, lightweight, and lightning-fast terminal coding agent designed to read code, search directories, edit files with unified diff approvals, run tests, and automatically execute commands to fulfill natural-language tasks.

Built entirely in TypeScript on the **Bun** runtime using **Ink** for a rich, responsive Terminal User Interface (TUI).

---

## Architecture Flow

```text
       ┌────────────────────────┐
       │ CLI input / TUI Prompt │
       └───────────┬────────────┘
                   │
                   ▼
       ┌────────────────────────┐
       │ buildSystemMessages()  │ ◄── OS, shell, CWD, git status, time
       └───────────┬────────────┘
                   │
                   ▼
       ┌────────────────────────┐
       │   LLMProvider Stream   │ ◄── Pinned Model & System Prompt
       └───────────┬────────────┘
                   ├─────────────────────────┐
                   ▼ (text_delta)            ▼ (tool_use)
       ┌────────────────────────┐    ┌────────────────────────┐
       │   Ink UI Text Stream   │    │  Zod Input Validation  │
       └────────────────────────┘    └───────────┬────────────┘
                                                 │
                                                 ▼
                                     ┌────────────────────────┐
                                     │ Permission Interceptor │
                                     └───────────┬────────────┘
                                                 ├───────────────────────┐
                                                 ▼ (Approved / Read-only)▼ (Denied)
                                     ┌────────────────────────┐ ┌────────┴────────┐
                                     │     Tool Execution     │ │  tool_result    │
                                     │ (Read, Edit, Bash,...) │ │  "user_denied" │
                                     └───────────┬────────────┘ └────────┬────────┘
                                                 │                       │
                                                 └──────────┬────────────┘
                                                            │
                                                            ▼
                                                Append to message history
                                                & loop back to Provider
```

---

## Features

- **Standardized Tool System**: Executes tools serially with strict parameter validation (Zod) and sandbox safety boundaries (paths must remain within the repository root).
- **Interactive Permission UI**: Prompts for `[y] yes / [n] no / [a] always` on modifying actions (like `Edit` or `Bash`), complete with colorful unified diff previews.
- **Robust Cancellation & Retry**: Interrupt running processes and model streams cleanly with `Ctrl+C`. Handles rate limits (429) and server drops (5xx) with exponential backoff and jitter.
- **Provider Abstraction**: First-class tested support for Anthropic Claude, OpenAI GPT-4o, and DeepSeek, with easy endpoint configuration.
- **Dynamic Context Suffix**: Computes runtime environment status (OS, Shell, Git porcelain status, Time, Token usage) to ground LLM context dynamically.

---

## Installation

### Prerequisites
- **Bun** (version `>= 1.2.0` is required). To install Bun:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **ripgrep** (optional fallback; recommended if prebuilt `@vscode/ripgrep` is blocked by system policies):
  ```bash
  # macOS
  brew install ripgrep
  # Debian/Ubuntu
  sudo apt-get install ripgrep
  ```

### Install Globally
```bash
bun install -g octonoesis
```

---

## Quickstart (5 Minutes)

1. Set your API Key in your environment:
   ```bash
   # For Anthropic (default)
   export ANTHROPIC_API_KEY="your-api-key"

   # For OpenAI
   export LLM_PROVIDER="openai"
   export OPENAI_API_KEY="your-api-key"
   ```

2. Run the agent in one of two modes:
   - **Interactive TUI Mode**:
     ```bash
     octonoesis
     ```
     This launches a full terminal dashboard showing the LLM conversation stream on the left, and a live in-memory TODO status panel on the right.
   
   - **One-shot Mode**:
     ```bash
     octonoesis "Fix the spelling mistake in src/utils/errors.ts"
     ```
     This streams the solution directly to standard output and exits.

---

## Documentation

To learn more about the technical details, architecture, and design decisions of the project:
- [MVP PRD](docs/prd.md) — What we built and why.
- [Architecture & ADRs](docs/architecture.md) — Technical modules and architecture log.
- [Tech Stack](docs/tech_stack.md) — Exact runtime and dependency specifications.
- [Roadmap](docs/roadmap.md) — The phase-by-phase implementation plan.
- [Development Progress Log](docs/progress.md) — Detailed milestones and completed dates.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
