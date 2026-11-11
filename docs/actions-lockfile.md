# GitHub Actions dependency lockfile

`.github/workflows/actions.lock` records the verified source repository identity,
release ref, and commit for every workflow action. Existing full-SHA `uses:` pins,
version comments, least-privilege permissions, and the Plugin promotion verifier
remain in place. Adopting this file does not enable a repository or organization
security policy, and the CI check does not rely on runner-side enforcement being
available for this repository.

## Generate and verify

Use the reviewed GitHub CLI extension version from `renovate.json`:

```sh
gh extension install github/gh-actions-lock --pin "$(jq -r '.constraints.ghActionsLock' renovate.json)"
gh actions-lock --no-narrow
gh actions-lock --verify --no-narrow
```

If the extension is already installed, check `gh actions-lock --version` against
the constraint before generating. Do not silently use a different release.

`--no-narrow` preserves the full-SHA workflow references. The tool may report
`sha-as-ref` warnings because these references are intentionally retained; those
warnings are not verification failures. The lockfile still records the upstream
release ref and exact commit. `--verify-local` is an optional offline coverage
check, not a substitute for CI's online provenance verification.

Never hand-edit the generated file, delete it to suppress a failure, or run
`--accept-moved` in automation. Investigate unexpected identity, ancestry, or tag
changes before changing the lock. Commit the workflow and lockfile together.

## Renovate updates

Renovate 44.24.0 and later support this native lockfile as an experimental feature.
The GitHub Actions manager
regenerates it when action references change, using `--no-narrow` and
`--no-onboard`. The `ghActionsLock` constraint selects the same tested generator
version for Renovate and CI. No custom manager or post-upgrade command is needed
for lockfile updates. Self-hosted Renovate using `binarySource=global` ignores
the constraint; its administrator must provision the same extension version.

Keep the existing grouped checkout update: workflow checkout references and the
literal reviewed checkout pin in `scripts/plugin-distribution.mjs` must change in
the same PR. Review the resulting lockfile in that PR as well. New workflows and
new action dependencies need a normal local generation run because Renovate does
not onboard them automatically.

For every action update, review:

- The upstream release and the exact old and new commits.
- The workflow references and their version comments.
- The matching lockfile references, commits, source owner/repository IDs, and any
  transitive dependencies. Unexpected identity changes must be investigated.
- Any matching privileged verifier pins, plus the full CI result.

The pilot keeps the existing commits unchanged. Before rollout to another
repository, verify the actual Renovate update path and CI. A local reproduction
of Renovate's command is useful evidence but is not a hosted Renovate run.

References: [GitHub lockfile guide](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies),
[generator](https://github.com/github/gh-actions-lock), and
[Renovate GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/).
