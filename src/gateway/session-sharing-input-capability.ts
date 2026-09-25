import type { SessionMutationAuthorization } from "./server-methods/types.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import type { SessionMutationWorkerRead } from "./session-sharing-worker-read.js";

const sessionInputAuthorizationIssuer = Symbol("sessionInputAuthorizationIssuer");

class SessionInputAuthorization {
  readonly #read: SessionMutationWorkerRead;
  readonly #assert: (facts: PreparedSessionMutationFacts) => void;
  readonly #release: () => void;

  constructor(
    issuer: symbol,
    read: SessionMutationWorkerRead,
    assert: (facts: PreparedSessionMutationFacts) => void,
    release: () => void,
  ) {
    if (issuer !== sessionInputAuthorizationIssuer) {
      throw new Error("Session input authorization requires its original resolver");
    }
    this.#read = structuredClone(read);
    this.#assert = assert;
    this.#release = release;
    Object.freeze(this);
  }

  static capture(value: unknown): SessionInputAuthorization {
    if (typeof value !== "object" || value === null || !(#read in value)) {
      throw new Error("Pending input requires its original prepared session authorization");
    }
    return value;
  }

  get workerRead(): SessionMutationWorkerRead {
    return structuredClone(this.#read);
  }

  assertCurrent(facts: PreparedSessionMutationFacts): void {
    this.#assert(facts);
  }

  release(): void {
    this.#release();
  }
}

export type PreparedSessionInputAuthorization = SessionInputAuthorization;

/** A copied preparation result cannot acquire the resolver's private authority. */
export function capturePreparedSessionInputAuthorization(value: unknown) {
  return SessionInputAuthorization.capture(value);
}

const sessionInputPreparationKey = Symbol("sessionInputPreparation");

class SessionInputPreparationBinding {
  readonly #owner: SessionMutationAuthorization;
  readonly #prepare: () => Promise<PreparedSessionInputAuthorization | undefined>;

  constructor(
    owner: SessionMutationAuthorization,
    prepare: () => Promise<PreparedSessionInputAuthorization | undefined>,
  ) {
    this.#owner = owner;
    this.#prepare = prepare;
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(owner: SessionMutationAuthorization) {
    const value: unknown = Object.getOwnPropertyDescriptor(
      owner,
      sessionInputPreparationKey,
    )?.value;
    return typeof value === "object" && value !== null && #owner in value && value.#owner === owner
      ? value.#prepare
      : undefined;
  }
}

export function bindSessionInputPreparation(
  owner: SessionMutationAuthorization,
  prepare: () => Promise<PreparedSessionInputAuthorization | undefined>,
) {
  Object.defineProperty(owner, sessionInputPreparationKey, {
    value: new SessionInputPreparationBinding(owner, prepare),
  });
  return owner;
}

/** Only canonical authorization composition carries preparation to its exact new owner. */
export function inheritSessionInputPreparation(
  source: SessionMutationAuthorization | undefined,
  target: SessionMutationAuthorization,
): SessionMutationAuthorization {
  const prepare = source && SessionInputPreparationBinding.read(source);
  return prepare ? bindSessionInputPreparation(target, prepare) : target;
}

export async function prepareSessionInputAuthorization(
  owner: SessionMutationAuthorization | undefined,
): Promise<PreparedSessionInputAuthorization | undefined> {
  const prepare = owner && SessionInputPreparationBinding.read(owner);
  return prepare?.();
}

/** Seal only after the active resolver has retained and checked its original target. */
export async function prepareSessionInputCapability(
  prepare: () =>
    | Promise<
        | {
            workerRead: SessionMutationWorkerRead;
            assertCurrent: (facts: PreparedSessionMutationFacts) => void;
            release: () => void;
          }
        | undefined
      >
    | undefined,
): Promise<PreparedSessionInputAuthorization | undefined> {
  const preparation = prepare();
  if (!preparation) {
    return undefined;
  }
  const prepared = await preparation;
  if (!prepared) {
    return undefined;
  }
  try {
    return new SessionInputAuthorization(
      sessionInputAuthorizationIssuer,
      prepared.workerRead,
      prepared.assertCurrent,
      prepared.release,
    );
  } catch (error) {
    prepared.release();
    throw error;
  }
}
