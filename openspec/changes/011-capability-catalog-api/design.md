# Design
- Tool definition generated from artifact `inputs` (Zod → JSON Schema) and `description`.
- Only `status: approved` capabilities are listed by default (`?includeDraft=1` for review).
- Invoke is synchronous with a timeout; returns 200 for success and business_outcome, 422 for pre-flight failure, 500 for hard failure, 202 with intervention id for escalated.
- Idempotency key header optional; duplicate key returns the cached result.
- Demo script: system prompt lists tools from `GET /capabilities`; Claude calls the tool; script posts to invoke; feeds result back; Claude answers "Member 10042 has $1,234.56 in savings."
