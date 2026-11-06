# support-bot example

The acceptance example from the build plan: a PDF support bot behind an Express API.

```
src/bot.ts       # the 3-line bot: preset + docs + tools
src/tools.ts     # lookupOrder (read-only) + refundOrder (pauses for approval)
src/server.ts    # POST /api/support/chat · /resume · /stream (SSE)
src/full-api.ts  # every chain method in one agent, for reference
company-pdfs/    # sample corpus: warranty.pdf (3 pages), shipping.md,
                 # internal/escalation-playbook.md (staff-only),
                 # promo-notes.md (prompt-injection fixture)
```

## Run it

```bash
export ANTHROPIC_API_KEY=…         # or OPENAI_API_KEY
export COMPANY_NAME="Acme Appliances"
pnpm --filter example-support-bot start

curl -s localhost:3000/api/support/chat \
  -H 'content-type: application/json' -H 'x-customer-id: cust-1' \
  -d '{"message": "My blender broke, is it covered?"}'
# → { "reply": "...", "outcome": "resolved", "sources": [{ "title": "warranty", "page": 2 }] }
```

A refund request returns `outcome: "pending"` with a `runId`; approve it via
`POST /api/support/resume {"runId": "...", "approved": true}`.

Staff access (sees `internal/`) is granted by the server when `x-staff-token` matches `STAFF_TOKEN` —
groups are set server-side, never from the request body.

## Tests

`test/support-bot.test.ts` runs the §7 acceptance against a scripted mock model: page-correct
citations, internal-doc access control, the injection fixture failing to trigger a refund, escalation,
and the SSE stream. Regenerate the sample corpus with `pnpm --filter example-support-bot make-pdfs`.
