# Asset provenance

This document describes the origin and redistribution status of UnoRAG visual
assets and evaluation fixtures. The machine-readable, SHA-256-bound inventory
is [`assets/provenance.json`](./assets/provenance.json); CI rejects unregistered,
removed, or modified assets.

The UnoRAG maintainers completed the recorded engineering review on 2026-08-14
using repository history, generator sources, embedded file metadata and visual
inspection. This review found no third-party or customer material in scope.

## Uno identity

`public/brand/uno-mark.svg` and `docs/brand/uno-brand-board.svg` are original
project work created for Unobyte/UnoRAG. The PNG mark, favicon and Apple touch
icon are raster derivatives of the canonical SVG. They are distributed under
Apache-2.0 with the rest of this repository, subject to the separate brand-use
policy tracked for the stable release.

## Product visuals

`public/landing-evidence-desk.png` is project-created landing artwork.
`public/product-library-workbench.png` is a screenshot of UnoRAG using synthetic
demonstration content and the non-routable `example.local` domain. Neither image
contains customer documents, production credentials, or personal information.

## Evaluation fixtures

Everything under `testdata/` is synthetic material authored or generated for
UnoRAG parser, chunking, retrieval, refusal and citation regression tests.
Company names, people, identifiers, prices and policies are fictional test
content. The DOCX files were generated with python-docx; the PDF fixtures were
generated with project scripts and ReportLab-compatible tooling. They are not
customer documents and are distributed under Apache-2.0.

Generated evaluation reports under `testdata/ab/_e2e_out/` are local evidence,
are ignored by Git, and are not release assets.

## Change policy

New or changed files in the governed paths must update the provenance manifest
with origin, license and SHA-256. Material without a clear right to redistribute
must be replaced or removed before merge. This inventory records engineering
evidence and is not legal advice.
