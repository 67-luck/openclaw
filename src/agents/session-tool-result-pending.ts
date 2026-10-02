import {
  SessionToolResultPendingConflictError,
  type PendingToolResultFact,
  type PendingToolResultOccurrence,
} from "./session-tool-result-pending-facts.js";

type PendingToolResultOwner = { readonly databasePath: string; readonly sessionId: string };
export const sessionToolResultPending = Symbol("sessionToolResultPending");
export const sessionToolResultRepair = Symbol("sessionToolResultRepair");
export type PendingToolResult = PendingToolResultOccurrence & {
  readonly owner: PendingToolResultOwner | undefined;
};
export type PendingToolResultDelta = {
  remove: readonly number[];
  add: readonly PendingToolResultOccurrence[];
};

function sameOwner(
  left: PendingToolResultOwner | undefined,
  right: PendingToolResultOwner | undefined,
) {
  return left?.databasePath === right?.databasePath && left?.sessionId === right?.sessionId;
}

/** Only this host owner holds live objects; workers receive operation-local occurrence facts. */
export function createSessionToolResultPending() {
  const pending = new Set<PendingToolResult>();
  const ordinals = new WeakMap<PendingToolResult, number>();
  const tentativeOwners = new WeakMap<PendingToolResult, object>();
  const reservations = new Set<{
    owner: PendingToolResultOwner | undefined;
    transaction?: object;
    staged: boolean;
  }>();
  let nextOrdinal = 0;
  const conflict = (): never => {
    throw new SessionToolResultPendingConflictError();
  };
  const assertAvailable = (owner: PendingToolResultOwner | undefined, transaction?: object) => {
    if (
      [...reservations].some(
        (reservation) =>
          sameOwner(reservation.owner, owner) &&
          (!transaction || reservation.transaction !== transaction || !reservation.staged),
      )
    ) {
      conflict();
    }
  };
  const ordinalOf = (call: PendingToolResult) => {
    let value = ordinals.get(call);
    if (value === undefined) {
      value = nextOrdinal++;
      ordinals.set(call, value);
    }
    return value;
  };
  const membershipChange = (
    remove: readonly PendingToolResult[],
    add: readonly PendingToolResult[],
  ) => {
    const removed: PendingToolResult[] = [];
    const added: PendingToolResult[] = [];
    return {
      stage(transaction?: object) {
        for (const call of remove) {
          if (pending.delete(call)) {
            removed.push(call);
          }
        }
        for (const call of add) {
          if (!pending.has(call)) {
            ordinalOf(call);
            pending.add(call);
            added.push(call);
            if (transaction) {
              tentativeOwners.set(call, transaction);
            }
          }
        }
      },
      rollback(this: void) {
        // Inverse only this operation. Another physical store can commit while
        // its predecessor is pending; restoring a whole Set would erase that work.
        for (const call of added) {
          pending.delete(call);
          tentativeOwners.delete(call);
        }
        for (const call of removed) {
          pending.add(call);
        }
        const ordered = [...pending].toSorted((left, right) => ordinalOf(left) - ordinalOf(right));
        pending.clear();
        ordered.forEach((call) => pending.add(call));
      },
      commit() {
        for (const call of added) {
          tentativeOwners.delete(call);
        }
      },
    };
  };
  const captureMembership = (owner: PendingToolResultOwner | undefined) => {
    const calls = [...pending].filter((call) => sameOwner(call.owner, owner));
    return {
      calls,
      assertCurrent(transaction?: object) {
        // Descendants may add tentative occurrences, but never replace the
        // original operation's facts or expand the tokens it can consume.
        const current = [...pending].filter(
          (call) =>
            sameOwner(call.owner, owner) &&
            (calls.includes(call) || !transaction || tentativeOwners.get(call) !== transaction),
        );
        if (
          current.length !== calls.length ||
          current.some((call, index) => call !== calls[index])
        ) {
          conflict();
        }
      },
    };
  };
  return {
    get size() {
      return pending.size;
    },
    ids: () => [...pending].map((call) => call.id),
    calls(owner: PendingToolResultOwner | undefined) {
      return [...pending].filter((call) => sameOwner(call.owner, owner));
    },
    clear() {
      if (reservations.size > 0) {
        conflict();
      }
      pending.clear();
    },
    serialize<T>(owner: PendingToolResultOwner | undefined, prepare: () => T): T {
      // A predecessor may still reserve this cohort. Serialization grants nothing,
      // but caller hooks must not silently change membership while producing bytes.
      const captured = captureMembership(owner);
      const value = prepare();
      captured.assertCurrent();
      return value;
    },
    capture(owner: PendingToolResultOwner | undefined, transaction?: object) {
      assertAvailable(owner, transaction);
      const capturedOwner = owner && Object.freeze({ ...owner });
      const captured = captureMembership(capturedOwner);
      const { calls } = captured;
      const assertCurrent = () => captured.assertCurrent(transaction);
      const facts: PendingToolResultFact[] = calls.map(
        ({ originId, callIndex, id, name, responseIds }, token) => ({
          token,
          originId,
          callIndex,
          id,
          name,
          responseIds,
        }),
      );
      const prepare = (delta: PendingToolResultDelta) => {
        const remove = delta.remove.map((token) => {
          const call = calls[token];
          if (!Number.isSafeInteger(token) || !call) {
            return conflict();
          }
          return call;
        });
        const add = delta.add.map((call) => Object.freeze({ ...call, owner: capturedOwner }));
        return membershipChange(remove, add);
      };
      return {
        facts,
        owner: capturedOwner,
        call(token: number) {
          return calls[token];
        },
        token(this: void, call: PendingToolResult) {
          const token = calls.indexOf(call);
          if (token < 0) {
            return conflict();
          }
          return token;
        },
        assertCurrent,
        stage(delta: PendingToolResultDelta) {
          const change = prepare(delta);
          return {
            ...change,
            stage(journal = transaction) {
              // Native preparation precedes the managed transaction's fixed
              // stage; validate against that original journal only when staged.
              assertAvailable(capturedOwner, journal);
              captured.assertCurrent(journal);
              change.stage(journal);
            },
          };
        },
        reserve(delta: PendingToolResultDelta) {
          assertAvailable(capturedOwner, transaction);
          assertCurrent();
          const change = prepare(delta);
          const reservation = { owner: capturedOwner, transaction, staged: false };
          reservations.add(reservation);
          let settled = false;
          return {
            stage() {
              if (!transaction || settled || reservation.staged) {
                throw new Error("Pending result has no live tentative reservation");
              }
              assertCurrent();
              change.stage(transaction);
              reservation.staged = true;
            },
            commit() {
              if (settled) {
                return;
              }
              // No caller checks after COMMIT: revocation cannot undo durable custody.
              if (!reservation.staged) {
                change.stage();
              }
              change.commit();
              settled = true;
              reservations.delete(reservation);
            },
            rollback() {
              if (settled) {
                return;
              }
              if (reservation.staged) {
                change.rollback();
              }
              settled = true;
              reservations.delete(reservation);
            },
            // Unknown outcomes deliberately retain the reservation and refuse reuse.
          };
        },
      };
    },
  };
}

export type SessionToolResultPending = ReturnType<typeof createSessionToolResultPending>;
