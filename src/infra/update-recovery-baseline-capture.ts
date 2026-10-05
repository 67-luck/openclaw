type RecoveryBaselineCaptureOptions = {
  assertCurrent: () => void;
};

/**
 * A beta updater treats original-state capture failure as a warning. Refuse
 * before writing a partial capture rather than fabricating recovery evidence.
 */
export async function captureUpdateRecoveryBaseline(
  options: RecoveryBaselineCaptureOptions,
): Promise<never> {
  options.assertCurrent();
  throw new Error(
    "Original-state capture is unavailable after switching to this older stable updater.",
  );
}
