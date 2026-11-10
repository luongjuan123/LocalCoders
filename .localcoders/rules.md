# LocalCoders Project Rules

## Architecture & Conventions
- Maintain clean, modular TypeScript / JavaScript architecture.
- Follow SOLID principles and separate business logic from UI.
- Use explicit error handling; never swallow uncaught exceptions.
- Prefer comprehensive unit and integration tests for every new feature.
- Follow idiomatic formatting and lint standards.

## Security
- Validate and sanitize all user and external inputs.
- Never hardcode API keys, secrets, or passwords in source code.

## Mandatory UI/UX Intelligence (UI/UX Pro Max)
- All agents working on UI, layouts, styles, webviews, and components MUST read and follow `.agents/skills/ui-ux-pro-max/SKILL.md` and `design-system/localcoders/MASTER.md`.
- Never use emojis as functional UI icons; use clean, accessible vector SVGs.
- Enforce Dark Mode developer ergonomics: deep slate backgrounds, high contrast text (4.5:1+), visible focus rings, and smooth 150-250ms transitions.
- Maintain strict view separation: 3-column Devin cockpit in Agent View; Monaco code editor with docked assistant in IDE View. Exactly one composer per view.
