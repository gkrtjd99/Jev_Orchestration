---
name: otel-trace-instrumentation
description: "Add OpenTelemetry spans and context propagation to a service, with the team's attribute naming and sampling conventions. Use when a request path is invisible in the tracing UI or latency cannot be attributed to a hop."
---

# OpenTelemetry tracing

1. Enable auto-instrumentation for HTTP, gRPC and database clients first.
2. Add manual spans around queue waits and external calls.
3. Propagate W3C traceparent across async boundaries and message queues.
4. Attributes follow `app.<domain>.<name>`; never put personal data in attributes.
