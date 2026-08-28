---
name: engineering-standards
description: Non-negotiable engineering standards for this trading repo (coding, errors, logging, config, security, trading/execution/risk, deployment). These OVERRIDE conflicting advice.
---

# Engineering Standards & Governance

This document defines the mandatory engineering standards that every AI specialist must follow.

It applies to every skill in this workspace, without exception.

If a recommendation conflicts with these standards, these standards take precedence.

---

# Core Principles

Protect capital before maximizing returns.

Correctness before performance.

Reliability before convenience.

Maintainability before cleverness.

Evidence before opinion.

Automation before manual processes.

Simple solutions before complex ones.

Fail safely rather than fail silently.

---

# Production Requirements

Every implementation must:

Be deterministic.

Be testable.

Be observable.

Be recoverable.

Be documented.

Be configurable.

Be secure.

Be maintainable.

Avoid hidden side effects.

---

# Coding Standards

Use:

CommonJS JavaScript — this repo has no TypeScript, no ESLint, no Prettier and no build step. Do not introduce one.

Syntax and APIs that run on Node 16 — the EC2 deploy pins Node 16 (Amazon Linux 2 / GLIBC 2.17).

`node -c <changed file>` as the fastest first check before pushing (CLAUDE.md: `node -c src/app.js  # syntax check (already allow-listed)`). It is a per-file syntax parse only — it does NOT follow `require()`, so `node -c src/app.js` will not catch a syntax error in any of the routers or services it loads. Run it on each file you actually changed. It is not a correctness gate on its own: `npm test` is the real gate — see Testing Standards below.

Meaningful naming

Small focused functions

Single responsibility

Dependency injection where appropriate

Immutable data where practical

Avoid:

Magic numbers

Deep nesting

Large classes

Large functions

Duplicate logic

Unused code

Hidden dependencies

Global mutable state

---

# Architecture Standards

This is a single Express process of CommonJS modules, not a layered enterprise app. Do not restructure it toward Clean Architecture, hexagonal ports/adapters or DDD — that advice does not fit and the regression suites read source files by path.

The shape that IS mandatory here:

Strategy rules live in exactly ONE place — `src/strategies/{name}.js`. Paper, Backtest, Live and Replay all call the same `getSignal()`. No route may re-implement a rule or an indicator.

Paper is canonical. When Backtest or Live disagrees with Paper, fix Backtest or Live.

Shared concerns already have an owner — reuse it, never re-implement: socketManager (the one Fyers socket), brokerSafety (retry + circuit breaker), tradeGuards, vixFilter, oiFilter, positionPersist, tradeLogger, capitalPool, portfolioRisk, charges, liveDryRun, notify, sharedNav.

Avoid circular dependencies and module-load-time state.

---

# Error Handling

Every external dependency must handle:

Timeouts

Retries (where safe)

Circuit breakers (where appropriate)

Meaningful error messages

Graceful degradation

Structured exceptions

Never swallow errors silently.

---

# Logging Standards

`console.log` is the logging API here — services/logger.js is required first in app.js and intercepts every console.* call into a rolling buffer plus the GET /logs/stream SSE feed.

Do not add a logging library, and do not strip console.log as if it were debug noise.

Every log should include where applicable:

Timestamp

Correlation ID

Trade ID

Order ID

Strategy ID

Severity

Message

Context

Never log:

Passwords

Secrets

API keys

Access tokens

Personally identifiable information

---

# Configuration Standards

All configuration must:

Come from environment variables — .env loaded by dotenv, with .env.example kept in step. There is no config-file layer.

Be read live from process.env at call time, never frozen at require() time. A Settings save mutates process.env in-process, so a module-load constant silently ignores the operator's change until a restart.

Be validated at startup.

Have safe defaults where appropriate, and the code default must match the default the Settings UI shows.

Support feature flags for risky functionality.

Appear in the Settings UI (src/routes/settings.js) when an operator is expected to change it — no new page or menu item ships without a toggle there.

Never hardcode production credentials.

---

# Security Standards

Validate inputs and sanitize anything interpolated into a route's HTML template literal — every page here is a hand-built string, so an unescaped value is an XSS hole.

Secrets live in `.env` only. Never log or echo `API_SECRET`, `LOGIN_SECRET`, `ACCESS_TOKEN`, broker keys or the contents of `.fyers_token` / `.zerodha_token`.

Two independent gates guard the app, and they fail differently: `LOGIN_SECRET` returns **401** until the `__trade_login` cookie is sent, `API_SECRET` returns **403** on any path missing from `OPEN_PATHS` / `OPEN_PREFIXES`. When neither is set every path is open, so an access-control gap stays invisible in local testing — test with both set.

---

# Data & Persistence Standards

There is no database, ORM, Redis or cache server in this repo. Do not propose one as a fix.

State lives as JSON / JSONL files under ~/trading-data/, outside the repo, so a git pull or a PM2 reload never wipes it.

Use:

Atomic writes (tmp file → rename) for anything a crash could truncate

Append-only JSONL for anything auditable — per-day trade logs, skip logs, settings snapshots

Coalesced async writes on hot paths, with a synchronous flush on process exit

The one in-repo data path is the tick recorder's <repo>/data/ticks, which survives deploys only because the deploy rsync runs without --delete. Do not add another.

---

# Performance Standards

Protect:

Event loop responsiveness

Memory stability

CPU efficiency

The shared tick fan-out hot path — socketManager delivers every tick to every subscribed strategy callback

WebSocket throughput

The PM2 heap ceiling — node_args --max-old-space-size=900 with max_memory_restart 940M on a t3.micro

Optimize only after measuring.

---

# Testing Standards

Every production change must be gated by:

`node -c <changed file>` — the syntax check, run on each file you actually changed. It does NOT follow `require()`.

`npm test` — the zero-dependency regression suites in tests/, built on node's built-in assert and exiting non-zero on failure. Read package.json for the current list; the chain grows with each strategy. Several suites assert by reading source files, so a pure refactor that moves code between files can fail them without changing behaviour — fix the assertion, don't skip the suite.

A recorded-session /replay run when decision, fill or exit logic changed

Failure scenario tests and risk validation where applicable

There is no test framework, no coverage tool and no lint task. A new test is a plain node script added to tests/ and to the `npm test` chain.

The deploy workflow runs no tests, so run them yourself before the push.

Every bug fixed in strategy, config or paper/live parity logic should leave a regression case behind in the matching tests/ suite.

Critical trading logic should not rely on manual testing alone.

---

# Trading Standards

Every strategy must define:

Market regime suitability

Entry rules

Exit rules

Stop-loss

Position sizing

Risk limits

No-trade conditions

Failure scenarios

Validation evidence

---

# Execution Standards

Every order must support:

Idempotency

Recovery after restart

Duplicate prevention

Timeout handling

Broker reconciliation

Audit trail

---

# Risk Standards

Always define:

Maximum daily loss

Maximum drawdown

Kill switches

Position limits

Exposure limits

Capital allocation

Emergency shutdown procedures

---

# Observability Standards

Every production component should expose:

Health checks

Structured logs

Metrics

Alerts

Performance counters

Error rates

Latency metrics

Business metrics

Here that means GET /health (uptime, heap MB, broker auth flags, circuit-breaker state, Telegram health), the GET /logs/stream SSE feed, Telegram alerts on crash / orphaned position / breaker trip, and the per-day JSONL trade and skip logs under ~/trading-data.

There is no metrics backend — do not assume Prometheus, Grafana or an APM.

---

# Documentation Standards

Docs are CHEAP here by default — this is a solo repo and the commit log is the changelog. Do not write prose about your own change.

Do NOT add a CHANGELOG.md entry unless asked. Put the explanation in the commit message.

README.md is orientation only (what strategies, modes and routes exist). Touch it only when one is added or removed. Do not document env keys there.

docs/ENV.md is GENERATED — never hand-edit. Run `npm run docs:env` after adding or removing an env key; `npm run docs:check` fails if it is stale.

Reporting back to the user is a few lines on what changed and why. No summary documents, no migration guides, no recap files unless asked.

The exception is a NEW strategy, which does earn a `documents/{NAME}_Strategy_Guide.html` — and every number in it must be re-derived from real engine output.

---

# Deployment Standards

Deployment here IS `git push origin main` — GitHub Actions rsyncs to EC2, runs npm install --omit=dev and `pm2 startOrRestart ecosystem.config.js --update-env`. There is no staging environment.

Never push unless the user explicitly asks for it. Commit freely; the deploy moment is theirs to time.

The .githooks pre-push hook blocks weekday pushes 09:00–15:30 IST. If it blocks, report it and stop — never ALLOW_PUSH=1, never --no-verify, never --force.

PM2 treats exit code 10 as the "config error, do not restart" sentinel (missing certs, malformed .env). Keep that path working; it is what stops a crash loop.

Before deployment verify:

Code review completed

Tests passing

Regression tests passing

Configuration validated

Rollback plan available

Monitoring enabled

Alerts configured

Risk review completed

Deployment approval granted

---

# Decision Framework

When choosing between two valid approaches, prioritize:

1. Safety
2. Correctness
3. Reliability
4. Simplicity
5. Maintainability
6. Performance
7. Developer convenience

---

# Definition of Production Ready

A feature is production-ready only if it is:

Functionally correct

Well tested

Recoverable

Observable

Secure

Documented

Maintainable

Configurable

Reviewed

Validated

Safe to operate

---

# Golden Principles

Production quality is built intentionally.

Small engineering shortcuts become large operational problems.

A reliable system is more valuable than a fast but fragile system.

Protect the user, protect the capital, protect the platform.

Engineering excellence is achieved through consistency, discipline, and continuous improvement.
