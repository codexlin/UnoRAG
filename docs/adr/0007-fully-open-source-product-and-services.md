# ADR-0007: Fully Open-source Product and Services Model

- Status: Accepted
- Date: 2026-08-06
- Scope: source availability, product composition, release readiness and services
- Supersedes: the private-repository, commercial-edition and entitlement decisions
  in ADR-0006
- Preserves: ADR-0005 runtime ownership and ADR-0006 coordinated monorepo and
  package-boundary direction

## Context

UnoRAG is intended to become a complete, generally useful knowledge product.
Splitting operations, observability or AI-engineering capabilities into paid code
editions would make the public product harder to trust, test and operate. It would
also make product architecture follow packaging policy instead of domain ownership.

The project's near-term goal is therefore to make one strong general-purpose
distribution, earn adoption through product quality and documentation, and offer
paid expertise around real customer environments. Private deployment remains an
important deployment mode, but it is not a separate source edition.

The repository is still private and has no open-source license at the time of this
decision. Making the intent public does not itself grant permission to use,
redistribute or modify the current source. Publication requires an explicit license
and the readiness gates below.

## Decision

UnoRAG will have one functionally complete open-source product distribution.

1. Generic product capabilities will not be separated into Community, Standard,
   Professional or AI-engineering source editions.
2. Security, ACL isolation, versioning, lifecycle recovery, native diagnostics,
   Ops Stack assets, Langfuse integration, evaluation and supported provider
   adapters are part of the same public product when implemented.
3. Optional means that an integration has additional deployment dependencies or is
   unnecessary for some installations. It does not mean that its source is paid.
4. UnoRAG will not add license keys, entitlement checks or build-time commercial
   feature gates.
5. Releases use one version, one lockfile, one migration history and one set of
   public acceptance criteria. Deployment profiles may select components without
   changing the product's source rights.
6. Paid work is delivered as professional service: architecture and capacity
   planning, installation, upgrades, integration, migration, RAG evaluation and
   tuning, customer-specific development, training, incident support and SLA.
7. Customer data, credentials, infrastructure configuration and customer-specific
   extensions remain private according to their contract. Reusable fixes and
   generally useful capabilities should be contributed upstream whenever permitted.

Apache-2.0 is the current candidate license because a permissive license best fits
wide adoption and downstream integration. It is not effective until provenance and
legal review are complete and a `LICENSE` file is committed. The final license and
any required notices are established by that release change, not by this ADR alone.

## Product Boundaries

The monorepo, when introduced, represents engineering ownership rather than paid
editions. The target package vocabulary may include:

```text
apps/                 web, worker and operational composition roots
packages/contracts    public HTTP, job, event and IR contracts
packages/core         chunking, retrieval, table execution and Ask graph
packages/database     Drizzle schema, repositories and migration owner
packages/auth         session, RBAC, ACL and Service Key policies
packages/parser       ParserProvider and parser adapters
packages/storage      local and object-storage adapters
packages/observability logs, metrics, traces, alerts and diagnostics
packages/evaluation   quality gates and Langfuse integration
packages/ui           shared product UI where a real second consumer exists
```

There are no `edition` or `professional` dependency layers. A package is still
created only when it enforces a real boundary or has multiple consumers; this ADR
does not authorize an empty-directory migration.

Private customer work should prefer configuration and stable provider interfaces.
When customer-specific code cannot be upstreamed, it belongs in a separate private
customer repository or deployment overlay and depends on public contracts. The
public repository must not accumulate customer secrets, data or one-off policy.

## Publication Gates

Repository visibility must not be changed until all of the following are complete:

1. Scan the full Git history and current tree for credentials, customer data,
   internal hostnames and private operational evidence; rotate exposed secrets.
2. Review source, dependencies, fonts, images, fixtures and generated artifacts for
   ownership and license compatibility.
3. Add the approved `LICENSE`, required notices and third-party attributions.
4. Add `SECURITY.md`, `CONTRIBUTING.md`, a code of conduct and public issue and pull
   request templates.
5. Decide whether to publish existing history or a reviewed clean-history export,
   and record that decision without hiding provenance obligations.
6. Publish reproducible, signed images and SBOM/provenance evidence from public CI.
7. Run the full release, isolation, real-file, browser and recovery acceptance suite
   against the exact release candidate.
8. Review public-facing names, trademarks, support expectations and vulnerability
   disclosure channels.

Until these gates pass, documentation must describe UnoRAG as **preparing for an
open-source release**, not as already licensed open source.

## Consequences

Positive consequences:

- every user can inspect and operate the same reliability and observability code;
- documentation, tests and integrations describe one product rather than a matrix;
- community adoption and real-world feedback can strengthen the general platform;
- paid work aligns with delivery expertise and customer outcomes instead of hidden
  implementation;
- package boundaries remain driven by technical ownership.

Costs and risks:

- public maintenance, security response and release discipline become product work;
- permissive licensing allows third parties to redistribute or commercialize forks;
- services revenue depends on reputation, delivery quality and differentiated
  expertise rather than code exclusivity;
- customer-specific changes require deliberate upstream/downstream management.

## Non-goals

- This decision does not make the repository public immediately.
- It does not promise free hosting, consulting, migration or SLA.
- It does not require publishing customer data, credentials or contract-specific
  extensions.
- It does not require a package extraction before the current product is stable.
- It does not create a hosted SaaS control plane.

## Acceptance Criteria

This decision is reflected when:

1. active product documentation no longer describes paid source editions;
2. optional Ops and Langfuse capabilities remain operable as public deployment
   profiles without entitlement checks;
3. release and CI use one product capability baseline;
4. customer-private code has an explicit extension or overlay boundary;
5. repository publication occurs only after every publication gate is evidenced.

## References

- [The Apache Software Foundation: Applying the Apache License](https://www.apache.org/legal/apply-license)
- [Open Source Initiative: Open Source Licenses](https://opensource.org/licenses)
