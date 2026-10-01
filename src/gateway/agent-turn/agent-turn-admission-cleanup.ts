import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";

/** Release failed preparation in owner order before allowing restart recovery to wake. */
export async function cleanupAgentTurnAdmission({
  lease,
  cleanupRunAbort,
  releaseGatewayAdmission,
  releaseCronContinuation,
}: {
  lease?: MainSessionRecoveryOwnerLease;
  cleanupRunAbort?: () => void;
  releaseGatewayAdmission: () => void;
  releaseCronContinuation: () => Promise<boolean>;
}) {
  let pendingRecovery: Awaited<ReturnType<typeof releaseMainSessionRecoveryOwner>> = undefined;
  try {
    pendingRecovery = await releaseMainSessionRecoveryOwner(lease);
  } finally {
    try {
      cleanupRunAbort?.();
      releaseGatewayAdmission();
    } finally {
      try {
        await releaseCronContinuation();
      } finally {
        scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
      }
    }
  }
}
