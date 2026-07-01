// @claustrum/channel-whatsapp — per-package ESLint flat config.
//
// This package is the home of the REAL raw-`fetch` egress chokepoint
// (`src/render.ts` → POST to api.twilio.com). Unlike every other @claustrum
// package it therefore carries the EGRESS BRAND enforcement (Plan 1 /
// Theorem E-1) on top of the shared config. Because a local flat config shadows
// the root one (ESLint stops walking up at the nearest config file), we re-spread
// the shared @claustrum/eslint-config first, then layer the egress bans.
//
// Defense-in-depth mirrors the ibatexas apps/api egress config:
//   (d) `no-restricted-imports` on the raw `twilio` SDK — egress must go through
//       a minter + the kernel-gated wrapper, never the SDK directly.
//   (e) `no-restricted-syntax` ban on any reference to the Twilio REST host
//       (`api.twilio.com`) — string literal OR template element — so a SECOND
//       raw-`fetch` egress cannot be smuggled in without the brand (Theorem E is
//       sole-EMITTER, not sole-importer; banning the SDK import alone leaves the
//       raw-HTTP vector open). The existing single `render.ts` fetch is the
//       sanctioned, `unwrapRendered`-gated chokepoint and is allowlisted below.

import config from "@claustrum/eslint-config";

const TWILIO_IMPORT_BAN = {
  name: "twilio",
  message:
    "Raw `twilio` SDK egress is restricted to the branded chokepoint (src/render.ts). Send customer text via sendTwilioMessage(...) with a RenderedReply minted in @adjudicate/core, unwrapped at the sink via unwrapRendered.",
};

// Ban any reference to the Twilio REST host outside the sanctioned chokepoint —
// both a bare string literal and a template-literal fragment (render.ts builds
// the URL as a template literal).
const TWILIO_REST_HOST_BAN = [
  {
    selector: "Literal[value=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress chokepoint (src/render.ts, Theorem E-1 sole-emitter). Send customer text via sendTwilioMessage(...) with a minted RenderedReply.",
  },
  {
    selector: "TemplateElement[value.raw=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress chokepoint (src/render.ts, Theorem E-1 sole-emitter).",
  },
];

export default [
  ...config,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [TWILIO_IMPORT_BAN] }],
      "no-restricted-syntax": ["error", ...TWILIO_REST_HOST_BAN],
    },
  },
  {
    // The sole sanctioned egress chokepoint: it legitimately POSTs to
    // api.twilio.com after `unwrapRendered` proves the brand's provenance.
    // Allowlist ONLY this file from the REST-host ban (it uses raw fetch, never
    // the SDK, so the import ban is irrelevant here).
    files: ["src/render.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
