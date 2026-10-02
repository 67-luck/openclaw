# Focused runtime cleanup proof

This carrier is intended only for the task branch
`proof/lg-runtime-hosted-evidence`. It changes no application source and must not
be merged into main. Pushing the reviewed carrier runs one `ubuntu-24.04` job;
there is no release dispatch, protected tag, registry publication, or Testbox.

Usage is pinned to the reviewed repair
`3a99184788fe3afd11f40ed75d909773f8c5fa11`, tree
`bcc8699638582f3928e731c6c2eae50a720c58d4`. Missing pins refuse execution. Npm is fixed at
`2f7a5c015cfa00861f6eb097c6265f2b79c3005b`, whose normal CI run
`36964998742` completed successfully. The task job supplies missing behavior
proof; it does not repeat or replace normal CI gates.

The carrier validates its exact workflow SHA and limits its delta from
`a4ad0b67b100308b25dae459f79b52d8b40fbdc5` to this proof directory and its
single workflow. Candidate checkouts are separate, detached, exact-SHA source
copies: depth two for the carrier and depth one for each candidate. Usage fetches
only its one fixed baseline commit at depth one for both controls. Every candidate and negative-control checkout installs frozen
dependencies before running commands. No operator state or external credentials
are provided. Checkout credentials are not retained, cache writes are disabled,
and workflow permissions are read-only.

Usage executes the existing original-reader and pre-revocation controls in
separate worktrees. Their JSON reports must fail at the named assertions; setup
or import failures do not count. It then runs the six focused suites on the
unchanged candidate and records file-level time and test counts. The known
pre-revocation patch is checksum-bound and its staged Git tree is verified.

Npm builds one canonical package from its exact source, then uses two fresh
published `openclaw@2026.9.7` installations. The direct cell exercises the
configured declaration stub during the real updater. The separate bridge cell
runs published Doctor first and records any resulting stub installation before
updating. Both keep canonical plugin availability, exact stub/source bytes,
installation provenance, and actionable diagnostics observable. A failed direct
cell remains failed even if the bridge works. Neither cell reseeds state during
update, rewrites core package metadata, or claims a publication. Published
`v2026.9.7` accepts same-version explicit file artifacts: `update-global.ts`
excludes them from the registry-version no-op, and `package-update-steps.ts`
compares nonempty build IDs. The canonical candidate build has a different
identity, so no version fixture is needed. If first-hop assertions fail, the
cell stops; later availability and guidance checks remain unproven.

The registry fixture serves only a synthetic plugin package; the published core
package comes from the actual npm registry. State, npm prefixes, baseline
worktrees, and tarballs stay outside the uploaded evidence directory. Artifacts
contain only synthetic fixture observations, command logs, source identities,
checksums, timing receipts, and test reports. Node `24.21.0` matches the carrier
base's `.github/workflows/ci.yml` `NODE_VERSION`; the existing setup action owns
Node/pnpm provisioning. The two lane steps run independently
and retain their real exit statuses. The job timeout is a 120-minute execution
ceiling, not a relaxed test timeout. GitHub destroys the ephemeral runner after
the job; no persistent lease or service is created.

Existing workflow limitations were checked at
`76832258508202d51fc5d1b8c384d0f733ee0de4`, unchanged for these surfaces
at the carrier base. Ordinary CI has no custom payload selector. Its published
updater reusable executes a fixed plugins-disabled fixture; Update Migration
accepts only registered survivor scenarios and has no npm-stub case. None accepts
these two negative controls. This narrow branch-only job avoids substituting a
generic or release-gated workflow for the requested source-specific evidence.
