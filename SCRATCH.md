# Current goal
Finish wiring the phone-portal Settings UI in the Forge desktop app: import and render the
already-written `PortalControl` as its own settings section, then verify with typecheck/build.

# Status
DONE (this task). Verified every claimed piece of the already-complete portal wiring and completed the
only missing piece:
- `electron/ipc-channels.ts` — `portalEnable`/`portalDisable` channels + `PortalStatus` includes `disabled`.
- `electron/main.ts` — `enablePortal()`/`disablePortal()` + IPC handlers; portal no longer auto-starts in `whenReady()`.
- `electron/preload.ts` and `src/lib/forge-api.ts` — `portal.enable()/disable()/getStatus()/onStatus()` exposed.
- `src/state/store.ts` — `enablePortal`/`disablePortal` actions; `portalStatus` defaults to `{ state: 'disabled' }`; `init()` subscribes + back-fills.
- `src/components/PortalControl.tsx` — already rewritten per spec (enable/starting/unavailable/ready states, auto-copy of link).
- `src/App.tsx` — no longer imports/renders `<PortalControl />` in the top bar.

# Changes made (this task, the only source edit)
- `src/components/SettingsOverlay.tsx`: added `import { PortalControl } from './PortalControl';` and rendered
  `<PortalControl />` as the final settings section (after the provider sections and the Permissions section),
  matching the existing `.settings-section` styling. Nothing else touched.

# Verified
- `npx tsc --noEmit -p .` — exit 0.
- `npm run build` — exit 0 (Vite built in ~5.75s; main process built for production). One pre-existing
  chunk-size warning, benign, not introduced by this change.

# Scope respected
- Did NOT touch the portal security model (auth, binding, tunnel logic) — wiring/UX only.

# Notes / carried-forward
- SCRATCH.md previously described an older "permission levels / operating modes" review goal. That agenda
  is not part of this task and has not been started; revisit only if the Operator asks. Its open questions
  (per-workspace vs global levels, config file, reconciling with the 4-mode system) remain unanswered.
