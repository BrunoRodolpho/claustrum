/**
 * TenantResolver — the adopter-supplied bridge between an inbound
 * channel event and the per-turn (SystemState, PolicyBundle).
 *
 * The Conductor does not know how the adopter assembles state. It
 * delegates: given (channel, customerId, sessionKey?), the resolver
 * returns:
 *  - the TenantConfig (voice, locale, environment)
 *  - the SystemState snapshot to pass to `adjudicate()`
 *  - the PolicyBundle for the tenant's kernel
 *
 * Multi-tenant deployments fan out by inspecting the channel event;
 * single-tenant deployments return a constant.
 */

import type { PolicyBundle, SystemState } from "./adjudicator.js";
import type { ChannelKind } from "./channel.js";

export interface TenantConfig {
  readonly tenantId: string;
  readonly displayName: string;
  readonly locale: string;
  readonly environment: "dev" | "staging" | "prod";
  readonly voice?: Record<string, unknown>;
  /** Tenant-scoped feature flags, e.g. "enable_output_adjudication". */
  readonly flags?: Record<string, boolean>;
}

export interface TenantResolution {
  readonly tenant: TenantConfig;
  readonly state: SystemState;
  readonly policy: PolicyBundle;
}

export interface TenantResolver {
  resolve(input: {
    readonly channel: ChannelKind;
    readonly customerId: string;
    readonly sessionKey?: string;
  }): Promise<TenantResolution>;
}
