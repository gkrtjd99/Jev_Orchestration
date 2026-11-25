---
name: dependency-audit
description: "Audit third-party dependencies: known CVEs, reachability, fix versions, license compatibility, SBOM generation. Use when the question is about the risk carried by packages we depend on rather than by our own code."
---

# Dependency Audit

## Guidelines

1. Generate an SBOM per ecosystem from lockfiles.
2. Triage advisories by whether the vulnerable function is reachable.
3. Flag licenses outside the allowlist (GPL, AGPL, SSPL) with the dependency path.
4. Propose the smallest upgrade set that clears criticals.
