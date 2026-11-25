---
name: dmarc-spf-dkim-setup
description: "Set up and verify SPF, DKIM and DMARC DNS records for a new sending domain or a new email provider. Use before the first send from a domain, or when authentication checks fail in message headers."
---

# Email authentication records

1. Publish SPF with the provider include; keep under 10 DNS lookups.
2. Publish DKIM selectors (2048-bit) and send a test to confirm `dkim=pass` with alignment.
3. Start DMARC at `p=none` with a rua address, then tighten after two clean weeks.
4. Verify with `dig` and by reading Authentication-Results on a real message.
