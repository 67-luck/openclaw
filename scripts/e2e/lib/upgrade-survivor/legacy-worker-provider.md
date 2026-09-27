# Published updater × unchanged legacy worker provider

Targeted scenario: `legacy-worker-provider` in the existing
`published-upgrade-survivor` lane. This is package acceptance, not a new
release lane. It is intentionally absent from default, `reported-issues`,
and `far-reaching` selections. No provider secrets or paid infrastructure.

## Identities and the same-version first hop

`legacy-worker-baseline.json` pins the actual npm `openclaw@2026.9.6` archive.
Its SHA-512, SHA-1, and SHA-256 are checked; the complete installed application
payload is compared with that archive. The build metadata in those published
bytes declares commit `eb377ac59e6c9fd6c7705028034812becf00271b`. npm metadata
has no `gitHead`: this is a published build-metadata binding, not an inferred
release-tag source identity or independently verified npm provenance attestation.

The identity owner inventories every archive-derived non-dependency payload path,
including executable root helpers, scripts, docs, and the complete dist tree.
It compares bytes and inventory, not merely version/build metadata. npm owns
`node_modules` reification, so installed dependency-tree byte identity is not
claimed. The archive lifecycle-pending marker is consumed by the shipped
postinstall; a marker remaining in the installed tree still fails admission.

The selected candidate has its own tarball SHA-256, complete application payload,
version, build ID, and full source SHA. The source SHA must match the canonical
harness's `OPENCLAW_DOCKER_E2E_SELECTED_SHA`. Harness source identity is separate.
No future candidate commit or success is hardcoded. Candidate and baseline must
have different tarball hashes and build IDs, even when both versions are 2026.9.6.

Use the existing `candidate_update_spec` and `update_candidate` functions:
`openclaw update --tag file:<exact-candidate.tgz> --yes --json --no-restart`.
The **installed published CLI**, not npm and not the candidate CLI, drives this
first hop. The baseline's published `isPackageTargetAlreadyCurrent` excludes
explicit artifacts from the registry-version shortcut. Its package installer
only skips a same-version local artifact when the build ID also matches.
No version bump, registry republish, or baseline/candidate version-name substitution.

The observer preload records the actual updater PID, parent, process start,
entry path/hash, immutable starting build metadata, argv, and matching exit.
It does not intercept updater behavior. Existing successful-update assertions
still apply; this scenario additionally rejects empty steps, already-current,
wrong-baseline reports, incomplete exits, payload mismatch, and follow-up repair.
Baseline install, setup, and both baseline Gateway starts use the maintained
published-registry scope, preserving published bytes during registry phasing.

## Real owners and controlled infrastructure

`fixtures/legacy-worker-provider` is an external, dependency-free JavaScript
plugin written against the published V0 API. It does not declare
`liveAuthorityVersion`, use V1 callbacks, import candidate internals, or use the
bundled Crabbox provider. Install it with the baseline's real
`plugins install --link --force --accept-capabilities` command. Record its
external loader origin, every source-file digest, and the configured profile;
require the same files/profile after update and subsequent restarts.

The existing node-auto-update scenario was inspected: its process helpers are
private to a top-level updater scenario, and its package fixture rewrites
versions. Neither is an appropriate published-driver worker allocator. The
watchOS survivor is a synthetic protocol client, not a real worker host. This
scenario therefore keeps only a small local allocation backend beside the
maintained survivor runner; it adds no competing updater or workflow.

Only allocation infrastructure is synthetic. The isolated loopback backend owns
three local node processes and per-node homes. Before each build's first
allocation it copies the **currently installed** OpenClaw package and dependencies
to an immutable fixture runtime, so a Gateway package replacement cannot mutate
an existing node. It uses that installed version's public
`connect --target-file … --ephemeral` CLI with the baseline's public
`beginNodeEnrollment`/`waitForDeviceId` callbacks. The Gateway still prepares
its real bootstrap artifact and transfers and admits its real worker bundle over
native node IPC. No registry, storage, enrollment, worker admission, provisioning
service, or teardown owner is mocked. No inference is requested.

The Gateway uses the supported `gateway.bind=lan` listener inside its disposable
container. Its real enrollment owner selects the container LAN address and
includes the configured TLS certificate fingerprint. The backend checks that
the real setup code names an owned non-loopback interface, uses WSS, and carries
a SHA-256 pin; only that nonsecret transport receipt is published. The shared
survivor TLS fixture supplies the certificate and private CA. Local CLI and
HTTP probes use WSS/HTTPS localhost with normal CA validation; strict startup
still requires the ready marker and successful HTTPS `/readyz`. Control UI is
disabled for this headless fixture, not given an unsafe origin exception. No host
network, host-published ports, insecure transport flags, cloud or Tailscale.

The fixture does not test downloading/bootstrap-installing a cloud machine,
SSH, paid provider APIs, model inference, workspace attachments, or V1-provider
revocation races. Those are different proofs. This test exercises a real
unattached environment/lease and its dedicated node custody, not an active turn.

## Lifecycle oracle

1. Provision a control through baseline `environments.create`. Require ready
   (actual node admission), repeat its idempotency key, restart the owned Gateway,
   observe the provider's real inspection, and Stop twice. Exactly one backend
   allocation, process launch, and destruction must result.
2. Provision a second baseline lease, leave it ready, stop the Gateway through
   the existing harness route, and read its real SQLite custody **read-only**.
   Baseline service shutdown closes local work/transports and does not destroy
   completed idle leases. If the shipped flow behaves otherwise, fail with a
   setup/shutdown-contract error; never forge a retained row or silently pass.
3. Run the published updater once. Verify exact candidate bytes and complete
   driver receipts. Compare native environment IDs, operation IDs, profile
   snapshots, lease/node identity, shared-host custody, owner epochs, and admitted
   bundle hashes before candidate Gateway startup. No SQL inserts, updates,
   schema changes, fixture migrations, or candidate imports seed this state.
4. Start the candidate Gateway normally. Require a **new** inspection after the
   frozen pre-update counter, preserved public identities/profile, and
   idempotent create replay without another allocation. Stop the retained lease.
5. Provision and Stop a fresh candidate lease, repeat Stop, restart the Gateway,
   and require all three original native IDs terminal with no duplicate rows,
   extra allocations, repeated backend destruction, or live owned processes.

Receipts are test artifacts, not a new OpenClaw runtime store. The canonical
host redactor publishes `legacy-worker-proof.json`, bounded per-phase snapshots,
and backend counters. Private node logs and enrollment material remain in the
isolated runtime, not uploaded as raw receipts. The canonical summary owns final
success **after cleanup**; the proof file's `lifecycle-passed` alone is not a pass.
Finally attempts public teardown, stops the Gateway, then signals and joins the
backend. The backend joins actual child process groups, including failure paths.
Docker's existing timeout/container owner remains the outer containment boundary.

## Targeted dispatch and required verification

After review, commit the candidate normally, with normal repository hooks. Build
and pack that exact committed source using the canonical packer (do not supply
`--skip-build` or caller-level hook/script bypasses). Package Acceptance
`source=ref` already performs its supported clean-source install/build/pack.
The packer's internal npm-pack script policy is its existing implementation,
not permission to bypass Git hooks or omit the build.

Use the existing **Update Migration** caller, which forwards no provider secrets.
It fixes Package Acceptance to `source=ref`, `custom`, `update-migration`,
`no-push-artifact`, and Telegram `none`; that lane uses this same survivor runner.
Direct Package Acceptance dispatch forwards provider secrets and is not the
secretless route. Neither empty planner credential requirements nor container
environment unsets establish a secretless caller. No new workflow is needed.

After authorized canonical candidate/harness publication and exact-head readback:

```bash
gh workflow run update-migration.yml --repo openclaw/openclaw \
  --ref <reviewed-harness-branch> \
  -f workflow_ref=<exact-reviewed-harness-sha> \
  -f package_ref=<exact-committed-candidate-sha> \
  -f baselines=openclaw@2026.9.6 \
  -f scenarios=legacy-worker-provider
```

The caller exposes only these four inputs. Its plural baseline pins the actual
9.6 scenario group; the inner workflow still resolves a supported predecessor
for its separate fallback metadata. Do not pass singular baseline or artifact
inputs to Update Migration. Canonical source admission requires the candidate
to be reachable from an authorized canonical branch/tag, not just a fork PR.

Pack once. Retain the original producer run/attempt, artifact ID/digest, tarball
SHA-256, source SHA, version, build ID, and filename. After a downstream failure,
inspect failed-job-only recovery with retained producer outputs; this caller
has no artifact-source dispatch interface. Do not rerun the entire source=ref
workflow or fall back to direct secret-bearing dispatch to reuse an artifact.

Required parent-side checks include the focused oracle test,
`test/scripts/docker-e2e-plan.test.ts`, existing survivor package/registry and
diagnostics tests, changed checks, and this secretless canonical Docker cell.
Record measured test and lane costs. Unit/source contracts are not runtime proof.
A missing baseline runtime capability, failed native enrollment, updater refusal,
recovery-only outcome, missing receipt, or cleanup failure stays unfinished/red.
Do not replace it with direct npm installation or synthetic SQL. If a different
published predecessor is necessary, document its actual constraint and obtain
selection approval; this scenario only accepts the audited 2026.9.6 driver.
