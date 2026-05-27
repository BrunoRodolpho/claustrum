# Contributing to @claustrum/*

Thanks for your interest in contributing! This guide describes the workflow.

## Development setup

```bash
git clone https://github.com/BrunoRodolpho/claustrum.git
cd claustrum
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ and pnpm 10.32.1.

## The architectural invariants — non-negotiable

These rules survive every PR review. If your change violates one, it's rejected regardless of how well-written it is.

1. **The runtime never mutates state directly.** Every mutation goes through `adjudicate()` via the `Adjudicator` port. The LLM has zero state-mutation authority — it sees exactly one tool (`express_intent`) and the runtime resolves capability → tenant-appropriate implementation.

2. **Strict dependency direction:** `apps → runtime → kernel`. Adapter packages depend on `@claustrum/core` ports only; never on each other, never on `@adjudicate/core` internals beyond the public `Adjudicator` port surface.

3. **`Capsule` is the per-turn runtime handle. `RuntimeContext` is the per-tenant kernel container (exported by `@adjudicate/core`).** They are two different objects. PRs conflating them are rejected.

4. **Runtime may be probabilistic; kernel must remain deterministic.** Any kernel change that introduces non-determinism into `adjudicate()` is wrong by definition.

5. **Determinism is testable.** Property tests must declare expected invariants and assert `N ≥ 100` iterations.

## Pull request workflow

1. Create a feature branch from `main`
2. Make changes; ensure tests pass locally (`pnpm test`)
3. Add a changeset: `pnpm changeset` (describe the change, choose semver bump)
4. Open PR; CI runs lint, typecheck, test, audit
5. Reviewer checks architectural invariants
6. On merge: changesets bot creates a version PR; merging that publishes to npm

## Code style

- TypeScript ES2022, strict mode
- ESLint v9 flat config via `@claustrum/eslint-config` (no per-package override)
- Prettier defaults
- File naming: kebab-case (`channel-driver.ts`)
- Type names: PascalCase
- Port interfaces: PascalCase + `Port` suffix (`MemoryPort`)
- Adapter classes: PascalCase + `Provider` suffix (`AnthropicProvider`)

## Adding a new adapter package

1. Create `packages/<name>/` with `package.json` (peer-deps `@claustrum/core` + the underlying SDK)
2. Implement exactly one port from `@claustrum/core` (e.g., `ModelProvider`)
3. Pass the shared port-contract test suite from `@claustrum/core/test-doubles`
4. Add to `pnpm-workspace.yaml`
5. Add changeset

## Reporting security issues

See [SECURITY.md](./SECURITY.md). Do not file public issues for security vulnerabilities.

## License

Contributions are licensed under [MIT](./LICENSE).
