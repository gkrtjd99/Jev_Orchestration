---
name: log-pipeline-parsing-rules
description: "Write or fix parsing and field-extraction rules in the log ingestion pipeline (Vector VRL, grok patterns). Use when logs arrive as unstructured blobs, fields are missing in the log search UI, or a service changes its log format."
---

# Log parsing rules

1. Collect ten raw sample lines covering every variant.
2. Write the VRL transform with a fallback so unparsed lines are kept, not dropped.
3. Add the samples as unit tests for the transform.
4. Deploy to the canary pipeline first and confirm the fields in the search UI.
