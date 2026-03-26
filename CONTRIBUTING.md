# Contributing to DB Explorer for Firebird Databases

Thank you for your interest in contributing! This guide explains how to set up your development environment, coding conventions, and the process for submitting changes.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Fork and Clone](#fork-and-clone)
  - [Install Dependencies](#install-dependencies)
  - [Build and Run](#build-and-run)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
  - [Making Changes](#making-changes)
  - [Coding Style](#coding-style)
  - [Commit Messages](#commit-messages)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

---

## Code of Conduct

Please be respectful and considerate in all interactions. We follow the standard open-source community norms: be welcoming, constructive, and professional.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 16 or later
- [npm](https://www.npmjs.com/) 8 or later
- [Visual Studio Code](https://code.visualstudio.com/) 1.32 or later
- [Git](https://git-scm.com/)
- A running [Firebird](https://firebirdsql.org/) instance (optional, for integration testing)

### Fork and Clone

1. Fork the repository on GitHub.
2. Clone your fork locally:

   ```bash
   git clone https://github.com/<your-username>/vscode-db-explorer-firebird.git
   cd vscode-db-explorer-firebird
   ```

3. Add the upstream remote so you can pull in future changes:

   ```bash
   git remote add upstream https://github.com/mariuz/vscode-db-explorer-firebird.git
   ```

### Install Dependencies

```bash
npm install
```

### Build and Run

The project uses [esbuild](https://esbuild.github.io/) for fast bundling.

| Command | Description |
|---|---|
| `npm run compile` | Build the extension (output to `out/`) |
| `npm run watch` | Rebuild on every file change |
| `npm run tsc-compile` | Type-check with TypeScript (reference only — known pre-existing errors) |

To run the extension inside a VS Code Extension Development Host:

1. Open the repository folder in VS Code.
2. Press `F5` (or **Run → Start Debugging**).
3. A new VS Code window opens with the extension loaded.

---

## Project Structure

```
vscode-db-explorer-firebird/
├── docs/                      # Tutorials and guides
├── images/                    # Screenshots and banner images
├── resources/                 # Icons and SVG assets
├── snippets/                  # Firebird SQL code snippets
│   └── firebird.code-snippets
├── src/
│   ├── config/                # Configuration helpers
│   ├── interfaces/            # TypeScript interfaces and types
│   ├── language-server/       # IntelliSense / code completion
│   │   ├── completionProvider.ts
│   │   └── firebird-reserved.ts
│   ├── logger/                # Logging utilities
│   ├── mock-data/             # Mockaroo integration
│   ├── nodes/                 # Tree view nodes
│   ├── result-view/           # Query results webview
│   ├── shared/                # Shared utilities
│   ├── extension.ts           # Extension entry point
│   └── firebirdTreeDataProvider.ts
├── CHANGELOG.md
├── CONTRIBUTING.md            # This file
├── LICENSE
├── package.json
├── README.md
├── ROADMAP.md
└── tsconfig.json
```

---

## Development Workflow

### Making Changes

1. Create a feature branch from `master`:

   ```bash
   git checkout -b feature/my-feature
   ```

2. Make your changes, keeping commits small and focused.
3. Build and verify locally (`npm run compile`, then `F5` in VS Code).
4. Push your branch and open a Pull Request.

### Coding Style

- **TypeScript** is used throughout. Avoid `any` where possible — prefer explicit types.
- Formatting is enforced by **ESLint** (`.eslintrc.js`). Run the linter before committing:

  ```bash
  npx eslint src --ext .ts
  ```

- Prefer `const` over `let`; avoid `var`.
- Use `async/await` rather than raw `Promise` chains.
- Keep functions small and focused on a single responsibility.

### Commit Messages

Use the conventional commit format:

```
<type>(<scope>): <short summary>

[optional body]
[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Examples:**

```
feat(completion): add context-aware JOIN completion
fix(tree): prevent crash when database is unreachable
docs(readme): add connection setup screenshot
chore(deps): upgrade esbuild to 0.19
```

---

## Testing

The project uses VS Code's built-in Mocha test runner. Tests are in `src/test/`.

```bash
# Run extension tests (requires VS Code)
npm run test
```

When adding new features, check whether existing tests cover the affected code paths and add tests if they don't.

---

## Submitting a Pull Request

1. Ensure your branch is up to date with upstream `master`:

   ```bash
   git fetch upstream
   git rebase upstream/master
   ```

2. Push to your fork and open a PR against `mariuz/vscode-db-explorer-firebird:master`.
3. Fill in the PR template (what changed and why).
4. A maintainer will review your PR. Please respond to feedback promptly.

**PR checklist:**

- [ ] `npm run compile` succeeds with no new errors.
- [ ] ESLint passes (`npx eslint src --ext .ts`).
- [ ] New or changed behaviour is covered by tests (where applicable).
- [ ] `CHANGELOG.md` has an entry for user-facing changes.
- [ ] Documentation in `README.md` or `docs/` is updated if needed.

---

## Reporting Bugs

Use the [GitHub Issue Tracker](https://github.com/mariuz/vscode-db-explorer-firebird/issues) and choose the **Bug report** template. Please include:

- OS and VS Code version
- Firebird server version
- Steps to reproduce
- Expected vs actual behaviour
- Extension logs (open via **Firebird: Show Extension Logs** from the Command Palette)

---

## Requesting Features

Open an issue using the **Feature request** template. Check the [ROADMAP.md](ROADMAP.md) first to see if the feature is already planned.
