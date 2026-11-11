---
name: allium
description: Official Allium behavioral specification system (juxt/allium). Use for eliciting intent, distilling legacy code, tending specs, propagating to code/tests, and weeding drift.
---

# Allium Behavioral Engineering Commands

You support the complete Allium spec-driven engineering suite (`juxt/allium`). When the user issues any of the following commands (or references these workflows), follow their exact procedural steps:

---

## 1. `/allium:elicit` (Intent -> Spec)
**Purpose:** Work *forward* from human intent through a structured discovery interview to build an `.allium` spec from scratch.
**Procedure:**
1. Do NOT write code or spec upfront.
2. Ask 3-5 focused boundary questions testing invariants, transitions, error conditions, and edge cases.
3. Synthesize the user's answers into a formal `.allium` specification adhering to Allium v3 syntax (entities, lifecycles, invariants, when/requires/ensures rules).
4. Save the spec in the `spec/` directory.

---

## 2. `/allium:distill` (Code -> Spec)
**Purpose:** Work *backward* from an existing codebase to extract a behavioral spec.
**Procedure:**
1. Read the target implementation files and business logic.
2. Strip away framework boilerplate (Fastify, Express, SQL types, HTTP codes).
3. Extract core domain entities, transitions, and deterministic business rules.
4. Output a clean `.allium` specification.

---

## 3. `/allium:tend` (Spec Maintenance)
**Purpose:** Make targeted edits and updates to an existing specification as business requirements change.
**Procedure:**
1. Locate the target `.allium` file.
2. Update rules, entities, or invariants while ensuring existing transition graphs and invariants remain consistent.
3. Highlight breaking changes or newly required transitions to the user.

---

## 4. `/allium:propagate` (Spec -> Implementation & Tests)
**Purpose:** Propagate `.allium` specifications directly into TypeScript/database implementation and unit test suites.
**Procedure:**
1. Read the `.allium` contract.
2. Implement the TypeScript models/services and database schemas matching the declared entities.
3. Generate unit tests (e.g. `test-level-1.ts`) mapping 1:1 to every declared `rule`.

---

## 5. `/allium:weed` (Drift Reconciliation)
**Purpose:** Scan the project to detect where code and spec have drifted apart.
**Procedure:**
1. Compare `.allium` specs against active TypeScript/schema code and tests.
2. Surface discrepancies:
   - Code implementing undocumented behaviors.
   - Spec declaring rules that have no corresponding code or test coverage.
3. Reconcile both sides so spec and implementation match 100%.
