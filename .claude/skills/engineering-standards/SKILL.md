---
name: engineering-standards
description: Mandatory engineering standards & governance for every AI specialist in this trading repo. Invoke whenever writing, changing, reviewing, or deploying code, or when a specialist's recommendation must be checked against the platform's non-negotiable rules. Covers core principles, production requirements, coding/architecture/error-handling/logging/config/security/DB/performance/testing/trading/execution/risk/observability/documentation/deployment standards, the decision framework, and the definition of production-ready. These standards OVERRIDE any conflicting recommendation.
---

# Engineering Standards & Governance

This document defines the mandatory engineering standards that every AI specialist must follow.

It applies to:

- system-orchestrator
- nodejs-architect
- strategy-architect
- quant-research
- risk-manager
- trade-execution
- market-regime
- testing-engine
- code-review
- performance-optimizer
- devils-advocate
- trading-journal

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

TypeScript

Strict typing

ESLint

Prettier

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

Prefer:

Clean Architecture

SOLID

Hexagonal Architecture

Domain-driven boundaries

Event-driven communication where appropriate

Loose coupling

High cohesion

Explicit dependencies

Clear module ownership

Avoid circular dependencies.

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

Come from environment variables or configuration files.

Be validated at startup.

Have safe defaults where appropriate.

Support feature flags for risky functionality.

Never hardcode production credentials.

---

# Security Standards

Always:

Validate inputs.

Sanitize outputs.

Store secrets securely.

Use least privilege.

Rotate credentials.

Review dependency vulnerabilities.

Protect against common OWASP risks.

---

# Database Standards

Use:

Parameterized queries

Indexes for common lookups

Transactions where consistency matters

Migration scripts

Connection pooling

Avoid unnecessary database calls.

---

# Performance Standards

Protect:

Event loop responsiveness

Memory stability

CPU efficiency

Database latency

WebSocket throughput

Redis efficiency

Optimize only after measuring.

---

# Testing Standards

Every production change must include:

Unit tests

Integration tests

Regression tests

Failure scenario tests

Risk validation where applicable

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

---

# Documentation Standards

Every significant feature should include:

Purpose

Architecture

Dependencies

Configuration

Failure modes

Recovery procedures

Operational considerations

Future improvement ideas

---

# Deployment Standards

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
