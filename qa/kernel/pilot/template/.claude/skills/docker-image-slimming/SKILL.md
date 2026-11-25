---
name: docker-image-slimming
description: "Use when a container image is too large or slow to pull and needs to be reduced."
---

# Docker Image Slimming

Use when a container image is too large or slow to pull and needs to be reduced.

## Steps

1. Switch to a multi-stage build.
2. Copy only the files the process needs at run time.
3. Compare layer sizes before and after.
