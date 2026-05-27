# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in `@claustrum/*`, please report it privately. Do **not** file a public GitHub issue.

Email: security@brunorodolpho.com (or open a GitHub Security Advisory at https://github.com/BrunoRodolpho/claustrum/security/advisories/new)

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

We aim to acknowledge reports within 48 hours and provide a fix or mitigation within 14 days for critical issues.

## Scope

In scope:
- Any vulnerability in `@claustrum/*` packages that enables: bypassing the kernel (`@adjudicate/core`), executing tools without adjudication, leaking PII from audit records, signature forgery on `IntentEnvelope`, prompt-injection bypassing the runtime's input guards.
- Supply-chain vulnerabilities in `@claustrum/*` dependencies.

Out of scope:
- Vulnerabilities in `@adjudicate/core` (report at https://github.com/BrunoRodolpho/adjudicate/security)
- Vulnerabilities in the underlying LLM provider (report to Anthropic/OpenAI directly)
- Misconfiguration by adopters (e.g., publishing an `ANTHROPIC_API_KEY` to git)

## Coordinated disclosure

Once a fix lands:
- A CVE is requested if applicable
- Affected versions are documented in the release notes
- Adopters are notified via the `@claustrum/core` README + npm advisory
