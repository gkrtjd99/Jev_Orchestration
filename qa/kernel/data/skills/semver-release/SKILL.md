---
name: semver-release
description: "Cut a release: decide the semantic version bump from the changes, update version files, tag, build and publish packages, and create the release entry. Use when a new version has to be shipped."
---

# Semver Release

## Guidelines

1. Derive the bump from conventional commits; any breaking change means major.
2. Bump every workspace package that changed and its dependents.
3. Tag from a clean main and publish with provenance.
4. Never publish from a dirty tree or without a green pipeline.
