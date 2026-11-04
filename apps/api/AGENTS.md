# API instructions

- Keep `src/app.ts` and `src/index.ts` as composition roots. Executable entrypoints stay in `src/cli/`, where the build scripts expect them.
- Put API behavior in `src/modules/<domain>/`. Move existing domains in separate PRs without changing logic. Each module needs a short README describing its responsibility, boundaries, and exported entrypoints.
- Use kebab-case filenames. Keep `*.test.ts`, `*.postgres.test.ts`, and `*.test-support.ts` beside the code they exercise. Scenario tests may cover several files and do not need a same-named production file. Check their imports before calling them orphaned.
- Use relative `.js` imports within a module and `#modules/<domain>/<file>` across modules or from composition roots. Import named exports directly. Do not add barrels or compatibility re-exports for relocated internal files.
- Keep shared product behavior in workspace packages. Module routes assemble existing backend services. Avoid importing `app.ts` from production modules and keep dependencies explicit through the existing dependency objects.
- `pnpm --filter @orkbot/api test` runs offline tests. `pnpm --filter @orkbot/api test:postgres` starts disposable Postgres and runs the API database suites through the shared integration harness. The Vitest `postgres` project is enabled by `VERIFY_DATABASE`, which the harness sets. Never count skipped database tests as validation.
- Run `pnpm --filter @orkbot/api check`, `pnpm --filter @orkbot/api build`, and the relevant tests after a move. Generate the database client first with `pnpm db:generate`. Review dynamic imports, mock specifiers, fixtures, and filesystem paths as well as static imports.
- Use the monorepo's `pnpm lint` and `pnpm format` commands and root `biome.json`. Do not add a separate formatter, ESLint configuration, or module-specific lint exceptions.
- Keep `jsx: react-jsx` in the API typecheck: workspace auth exports include TSX email templates even though API source files contain no JSX. Tests remain in the same typecheck.
