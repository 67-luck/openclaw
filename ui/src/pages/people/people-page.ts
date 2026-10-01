import { consume } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  UserProfile,
  UsersListResult,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderConnectionAccess } from "../../components/connection-access.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { canonicalPersonProfile, canReadPersonProfile } from "../../lib/person-profile.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

registerProfileEnglish();
const copy = (key: string) => t(`profilePage.people.${key}`);
const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value
    : null;

export class PeoplePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property() personId = "";
  @state() private profiles: UserProfile[] | null = null;
  @state() private selfProfile: UserProfile | null = null;
  @state() private loading = false;
  @state() private failed = false;
  private requestId = 0;
  private source: unknown;
  private grantKey = "";
  private readonly connection = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.clear(),
    onSnapshot: ({ snapshot, initial }) => {
      const key = JSON.stringify([
        snapshot.phase,
        snapshot.hello?.auth?.role,
        snapshot.hello?.auth?.scopes,
        snapshot.hello?.auth?.sessionCap,
        snapshot.selfUser?.identity,
      ]);
      if (this.source !== snapshot.hello || this.grantKey !== key) {
        this.source = snapshot.hello;
        this.grantKey = key;
        this.clear();
        void this.load(!initial);
      }
    },
  });

  constructor() {
    super();
    new SubscriptionsController(this)
      .watchStore(() => this.context?.runtimeConfig)
      .effect(
        () => this.context?.gateway,
        (gateway) =>
          gateway.subscribeEvents((event) => {
            if (
              event.event === "sessions.changed" &&
              asOptionalRecord(event.payload)?.reason === "profile-identity"
            ) {
              this.clear();
              void this.load();
            }
          }),
      );
  }

  private clear() {
    this.requestId += 1;
    this.profiles = null;
    this.selfProfile = null;
    this.loading = false;
    this.failed = false;
  }

  private canList() {
    return canCallGatewayMethod(this.context.gateway.snapshot, "users.list", "operator.read");
  }

  private canReadConfig() {
    return canCallGatewayMethod(this.context.gateway.snapshot, "config.get", "operator.read");
  }

  private async load(refresh = false) {
    const scope = this.connection.capture();
    if (!scope || this.loading) {
      return;
    }
    const gateway = this.context.gateway;
    const hello = gateway.snapshot.hello;
    const revision = gateway.connectionRevision;
    const requestId = ++this.requestId;
    const isCurrent = () =>
      this.isConnected &&
      this.connection.isCurrent(scope) &&
      requestId === this.requestId &&
      gateway === this.context.gateway &&
      hello === gateway.snapshot.hello &&
      revision === gateway.connectionRevision;
    this.loading = true;
    this.failed = false;
    this.profiles = null;
    this.selfProfile = null;
    if (this.canReadConfig()) {
      void (
        refresh ? this.context.runtimeConfig.refresh() : this.context.runtimeConfig.ensureLoaded()
      ).catch(() => undefined);
    }
    try {
      if (this.canList()) {
        const result = await scope.client.request<UsersListResult>("users.list", {});
        if (isCurrent() && this.canList()) {
          this.profiles = result.profiles;
        }
      } else {
        const selfId = gateway.snapshot.selfUser?.identity?.id;
        if (selfId && canReadPersonProfile(gateway, selfId)) {
          const profile = await gateway.loadSelfProfile();
          if (isCurrent() && canReadPersonProfile(gateway, selfId)) {
            this.selfProfile = profile;
          }
        }
      }
    } catch {
      if (isCurrent()) {
        this.failed = true;
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
      }
    }
  }

  private selectPerson(profileId: string) {
    this.context.navigate("people", {
      pathname: pathForRoute("people", this.context.basePath),
      search: `?person=${encodeURIComponent(profileId)}`,
    });
  }

  private fact(title: string, value: unknown, description?: string) {
    return renderSettingsRow({
      title,
      description,
      stackedOnNarrow: true,
      control: renderSettingsValue(value),
    });
  }

  private policy(profile: UserProfile) {
    const config = this.context.runtimeConfig.state;
    const snapshot = config.configSnapshot;
    // Only applied runtime facts describe policy. Saved drafts can differ from live access.
    const runtime =
      this.canReadConfig() &&
      config.connected &&
      config.client === this.context.gateway.snapshot.client
        ? snapshot?.runtimeConfig
        : undefined;
    if (!runtime || config.configLoading || config.lastError) {
      return renderSettingsSection(
        { title: copy("policy") },
        renderSettingsEmpty(copy(config.configLoading ? "policyLoading" : "policyUnavailable")),
      );
    }
    const roles = asOptionalRecord(asOptionalRecord(runtime.gateway)?.roles);
    if (profile.id === GATEWAY_OWNER_PROFILE_ID || !roles) {
      return renderSettingsSection(
        { title: copy("policy") },
        renderSettingsEmpty(
          copy(profile.id === GATEWAY_OWNER_PROFILE_ID ? "ownerPolicy" : "rolesOff"),
        ),
      );
    }
    const definitions = asOptionalRecord(roles.definitions);
    const assigned = profile.role;
    const assignedKnown = Boolean(assigned && definitions && Object.hasOwn(definitions, assigned));
    const roleName = assignedKnown
      ? assigned
      : typeof roles.default === "string"
        ? roles.default
        : null;
    const policy =
      roleName && definitions && Object.hasOwn(definitions, roleName)
        ? asOptionalRecord(definitions[roleName])
        : undefined;
    if (!policy) {
      return renderSettingsSection(
        { title: copy("policy") },
        renderSettingsEmpty(copy("noPolicy")),
      );
    }
    const sessions = asOptionalRecord(policy.sessions);
    const model = asOptionalRecord(policy.modelPolicy);
    const agents = policy.agents === "*" ? copy("allAgents") : stringList(policy.agents);
    const scopes = stringList(policy.scopes);
    const allow = model ? stringList(model.allow) : null;
    const deny = model ? stringList(model.deny) : null;
    return renderSettingsSection(
      { title: copy("policy"), description: copy("ceilingHint") },
      html`
        ${this.fact(
          copy("policySource"),
          roleName,
          copy(assignedKnown ? "assignedPolicy" : assigned ? "retiredPolicy" : "defaultPolicy"),
        )}
        ${this.fact(
          copy("agents"),
          typeof agents === "string"
            ? agents
            : agents === null
              ? copy("unknown")
              : agents.length
                ? agents.join(", ")
                : copy("noneAgents"),
        )}
        ${this.fact(
          copy("otherSessions"),
          typeof sessions?.others === "string"
            ? copy(`others.${sessions.others}`)
            : copy("unknown"),
          copy("sessionHint"),
        )}
        ${this.fact(copy("sandbox"), copy(policy.sandbox === "required" ? "sandboxRequired" : "sandboxInherit"), copy("sandboxHint"))}
        ${this.fact(copy("scopes"), scopes === null ? copy("unknown") : scopes.length ? scopes.join(", ") : copy("noScopes"), copy("scopeHint"))}
        ${this.fact(copy("models"), model ? copy("modelsRestricted") : copy("modelsInherited"), copy("modelHint"))}
        ${
          model
            ? html`
                ${this.fact(copy("modelSource"), typeof model.sourceAgent === "string" ? model.sourceAgent : copy("defaultSource"))}
                ${this.fact(copy("modelAllow"), allow === null ? copy("sourceModels") : allow.length ? allow.join(", ") : copy("noModels"))}
                ${this.fact(copy("modelDeny"), deny?.length ? deny.join(", ") : copy("none"))}
              `
            : nothing
        }
        ${this.fact(copy("accessPolicy"), typeof policy.accessPolicyPlugin === "string" ? policy.accessPolicyPlugin : copy("none"), copy("eligibilityHint"))}
      `,
    );
  }

  override render() {
    const connected = this.connection.connected;
    const selfId = this.context?.gateway.snapshot.selfUser?.identity?.id;
    const requestedId = this.personId || selfId || "";
    const profile = this.profiles
      ? canonicalPersonProfile(this.profiles, requestedId)
      : this.selfProfile?.id === requestedId
        ? this.selfProfile
        : null;
    const showSelf = !this.personId || Boolean(selfId && profile?.id === selfId);
    const directory = this.profiles
      ?.filter((person) => !person.mergedInto)
      .toSorted((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id));
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("people"),
        subtitle: subtitleForRoute("people"),
        actions: html`<button
          class="btn"
          ?disabled=${!connected || this.loading}
          @click=${() => void this.load(true)}
        >
          ${t("common.refresh")}
        </button>`,
      })}
      ${renderSettingsWorkspace(
        renderSettingsPage(
          !connected
            ? renderSettingsEmpty(copy("offline"))
            : html`
                ${
                  showSelf
                    ? html`
                        ${renderConnectionAccess({
                          scopes: this.context.gateway.snapshot.hello?.auth?.scopes ?? null,
                          reconnect: () => this.context.gateway.connect(),
                        })}
                        ${renderSettingsSection(
                          { title: copy("thisConnection") },
                          this.fact(
                            copy("otherSessions"),
                            this.context.gateway.snapshot.hello?.auth?.sessionCap
                              ? copy(
                                  `others.${this.context.gateway.snapshot.hello.auth.sessionCap}`,
                                )
                              : copy("noReportedCap"),
                            copy("sessionHint"),
                          ),
                        )}
                      `
                    : nothing
                }
                <div class="settings-directory-detail">
                  <div class="settings-stack">
                    ${renderSettingsSection(
                      { title: copy("directory") },
                      this.loading
                        ? renderSettingsLoadingSkeleton({ rows: 3 })
                        : this.failed
                          ? renderSettingsEmpty(copy("unavailable"))
                          : !this.canList()
                            ? html` ${renderSettingsEmpty(copy("directoryDenied"))}
                              ${renderSettingsNavRow({
                                title: copy("thisConnection"),
                                onClick: () =>
                                  this.context.navigate("people", {
                                    pathname: pathForRoute("people", this.context.basePath),
                                    search: "",
                                  }),
                              })}`
                            : !directory?.length
                              ? renderSettingsEmpty(copy("empty"))
                              : directory.map((person) =>
                                  renderSettingsNavRow({
                                    title:
                                      person.displayName?.trim() ||
                                      person.githubIdentity?.login ||
                                      copy("person"),
                                    description:
                                      person.id === GATEWAY_OWNER_PROFILE_ID
                                        ? copy("owner")
                                        : (person.role ?? copy("unassigned")),
                                    onClick: () => this.selectPerson(person.id),
                                  }),
                                ),
                    )}
                  </div>
                  <div class="settings-stack">
                    ${
                      profile
                        ? html`
                            ${renderSettingsSection(
                              { title: profile.displayName?.trim() || copy("person") },
                              this.fact(
                                copy("assignedRole"),
                                profile.id === GATEWAY_OWNER_PROFILE_ID
                                  ? copy("owner")
                                  : (profile.role ?? copy("unassigned")),
                                copy("assignmentHint"),
                              ),
                            )}
                            ${this.policy(profile)}
                          `
                        : this.loading
                          ? renderSettingsLoadingSkeleton({ rows: 4 })
                          : renderSettingsEmpty(
                              copy(requestedId ? "personUnavailable" : "choosePerson"),
                            )
                    }
                  </div>
                </div>
              `,
          { wide: true },
        ),
      )}
    `;
  }
}

if (!customElements.get("openclaw-people-page")) {
  customElements.define("openclaw-people-page", PeoplePage);
}
