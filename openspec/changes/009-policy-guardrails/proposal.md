# Change: Safety and policy guardrails

## Why
Regulated financial data. The agent must not act outside an allowlist, risky actions must be
handled conservatively, and no secrets or raw PII may reach artifacts or logs.

## What changes
`policy.yaml` loader and validator; allowlist enforcement at the surface boundary (origins,
action types, blocked url patterns); risk classifier; redactor applied to every evidence write
and artifact write; policy tests.

## Out of scope
Auth for the console; encryption at rest.
