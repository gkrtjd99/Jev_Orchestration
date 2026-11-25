---
name: unit-test-vitest
description: "How we write unit tests with Vitest: file layout, naming, table-driven cases, fake timers, mocking boundaries and coverage expectations. Use when adding or restructuring isolated tests for functions or modules."
---

# Unit Test Vitest

## Guidelines

1. Co-locate as *.test.ts; one describe per exported unit.
2. Use test.each tables for boundary values; assert on behavior, not implementation.
3. Mock only at module boundaries; use vi.useFakeTimers for time.
4. New modules need branch coverage of at least 90 percent.
