import { createGitHubCiAutomationRenderer } from "@openclaw/github/control-ui-api.js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { isCronJobRunning } from "../../../lib/cron-status.ts";
import { formatMs } from "../../../lib/format.ts";

registerChatCiEnglish();

export const renderChatCiAutomation = createGitHubCiAutomationRenderer({
  t,
  isCronJobRunning,
  formatMs,
  jobHref: (id, basePath) => pathForRoute("cron", basePath) + "?job=" + encodeURIComponent(id),
});
