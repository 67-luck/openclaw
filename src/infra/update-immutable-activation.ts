type ImmutableActivationOptions = {
  root: string;
  onReceipt?: (line: string) => void;
};

function unsupported(options: ImmutableActivationOptions): never {
  options.onReceipt?.("immutable:stable-downgrade-refused");
  throw new Error(
    "Immutable activation belongs to a newer updater. The selected generation was not changed; recover it with the version that adopted this installation.",
  );
}

/** Never adopt or mutate a newer immutable activation record from this stable line. */
export async function activateImmutableUpdate(options: ImmutableActivationOptions): Promise<never> {
  return unsupported(options);
}

/** Never adopt or mutate a newer immutable recovery record from this stable line. */
export async function recoverImmutableUpdate(options: ImmutableActivationOptions): Promise<never> {
  return unsupported(options);
}
