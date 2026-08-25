# Current goal
Outline and implement clearer, more explicit permission levels / operating modes for the Forge agent (improving on the current DRAFT/PREPARE/EXECUTE/AUTO model from 05-GOVERNANCE.md and the tiered rule disclosure system).

# Decisions
- Current system uses progressive rule loading (Tier 0/1 via rules-service.ts + 09-RULE-INDEX.md), governance rules in 05-GOVERNANCE.md, human review of diffs via ReviewOverlay, and audit logging.
- We want to evolve this into a more structured, configurable set of permission levels that can be chosen per workspace/session.
- The prompt below was created after a full review of rules/, electron/agent-service.ts, rules-service.ts, session-store.ts, audit-service.ts, workspace-manager.ts, ReviewOverlay.tsx, and AgentPanel.tsx.

# Changes made
- Created SCRATCH.md with this plan (2025-04-05)

# Next steps
- Deliver the detailed prompt to the Operator.
- Once approved, implement the new permission mode system (likely involving updates to rules, agent-service, UI controls, and possibly a config file).

# Facts learned
- Forge is an Electron + React + TS desktop AI coding harness with very strict grounding, trust, and governance rules.
- Edits are never applied directly — always via reviewable diffs (propose_edit tool).
- Rule loading is dynamic and trigger-based to keep context small.
- There is already a conceptual 4-mode system in 05-GOVERNANCE.md.

# Open questions
- Should permission levels be per-workspace, per-session, or global?
- Do we want a config file (e.g. forge.json) to set default mode?
- Should there be a visual mode indicator + dropdown in the AgentPanel?
