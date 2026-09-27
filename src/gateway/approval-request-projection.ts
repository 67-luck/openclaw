/** Keep the originating message on the live request for native reviewer delivery only. */
export function projectApprovalRequestForExternal<TRequest extends object>(
  request: TRequest,
): TRequest {
  const source = "approvalSource" in request ? request.approvalSource : undefined;
  if (!source || typeof source !== "object" || !("userMessageExcerpt" in source)) {
    return request;
  }
  const approvalSource = { ...source };
  delete approvalSource.userMessageExcerpt;
  // SAFETY: Gateway approval requests make the source excerpt optional; removing it preserves the request type.
  return { ...request, approvalSource } as TRequest;
}
