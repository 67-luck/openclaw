import { copyAuthProfileAuthorizationIntent } from "./authorization-lifetime.js";
import type { AuthProfileCredential } from "./types.js";

/** Secret references persist without their resolved literals; native write intent follows the projection. */
export function serializeAuthProfileCredential(
  credential: AuthProfileCredential,
): AuthProfileCredential {
  if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
    const { key: _key, ...sanitized } = credential;
    copyAuthProfileAuthorizationIntent(credential, sanitized);
    return sanitized;
  }
  if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
    const { token: _token, ...sanitized } = credential;
    copyAuthProfileAuthorizationIntent(credential, sanitized);
    return sanitized;
  }
  return credential;
}
