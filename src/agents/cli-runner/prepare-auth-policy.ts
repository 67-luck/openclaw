import type {
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import type { BundledCliBackendAuthPolicy } from "./cli-backend-auth-policy.js";

export function shouldSkipLocalCliCredentialEpoch(params: {
  authEpochMode?: CliBackendAuthEpochMode;
  authProfileId?: string;
  authCredential?: AuthProfileCredential;
  preparedExecution?: CliBackendPreparedExecution | null;
}): boolean {
  return Boolean(
    params.authEpochMode === "profile-only" &&
    params.authProfileId &&
    params.authCredential &&
    params.preparedExecution,
  );
}

export function shouldResolveAuthProfileForExecution(params: {
  policy?: BundledCliBackendAuthPolicy;
  authCredential?: AuthProfileCredential;
}): boolean {
  if (!params.policy) {
    return false;
  }
  if (!params.authCredential) {
    return params.policy.strictSelectedProfile;
  }
  if (params.authCredential.type === "oauth") {
    return params.policy.oauthRefreshOwner === "core";
  }
  return params.authCredential.type === "api_key" || params.authCredential.type === "token";
}
