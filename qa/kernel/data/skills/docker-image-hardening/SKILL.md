---
name: docker-image-hardening
description: "Shrink and harden container images: multi-stage builds, minimal or distroless bases, non-root users, pinned digests, removal of build tooling and vulnerable OS packages. Use when an image is too large or fails a security scan."
---

# Docker Image Hardening

## Guidelines

1. Build in one stage, copy only artifacts into a minimal runtime stage.
2. Run as a numeric non-root UID with a read-only root filesystem.
3. Pin base images by digest and rebuild on base updates.
4. Scan the result and record size and findings before/after.
