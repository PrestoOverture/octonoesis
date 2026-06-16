# Contributing to Octonoesis

Thank you for your interest in contributing to Octonoesis! We welcome all contributions, including bug fixes, feature requests, documentation improvements, and feedback.

## Setup Development Environment

To set up a local development environment for Octonoesis:

1. **Install Bun**: Make sure you have Bun version `>= 1.2.0` installed:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Clone the Repository**:
   ```bash
   git clone https://github.com/PrestoOverture/octonoesis.git
   cd octonoesis
   ```

3. **Install Dependencies**:
   ```bash
   bun install
   ```

## Development Commands

We use a set of standard scripts for quality checks and testing:

- **Run Dev CLI**: Launch the TUI or One-shot mode directly from source:
  ```bash
  bun run dev
  bun run dev "summarize docs/prd.md"
  ```
- **Run Typechecking & Linting**:
  ```bash
  bun run check
  ```
  This runs both the TypeScript compiler (`tsc --noEmit`) and the Biome linter/formatter (`biome check .`).
- **Auto-Format Code**:
  ```bash
  bun run format
  ```
  This uses Biome to format the codebase.
- **Run Tests**:
  ```bash
  bun test
  ```
  Runs the unit and integration tests (excluding buggy-repo fixture tests).

## Pull Request Checklist

Before submitting a Pull Request, please ensure:

1. **Typecheck & Lint Pass**: Running `bun run check` produces zero errors or warnings.
2. **Tests Pass**: Running `bun test` passes all tests.
3. **No Unchecked Code Changes**: Avoid changing target code files without adding accompanying unit/integration tests.
4. **Documentation**: If your changes introduce new configurations, behavior, or tools, update the corresponding markdown documents in `docs/` and audit them using `bash docs/.audit-queries.sh`.
