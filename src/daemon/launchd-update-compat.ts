/** Private build edge for updater compatibility chunks; launchd-runtime owns behavior. */
export {
  readCorrespondingLaunchAgentCommand,
  readLoadedLaunchAgentState,
} from "./launchd-runtime.js";
