import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFileSync, type OwnedFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { assertDirectoryIdentitySync, sameFileIdentity } from "./fs-safe-advanced.js";
import { root } from "./fs-safe.js";
import {
  runWithSqliteCoordinator,
  throwSqliteLifecycleErrors,
  tryAcquireExclusiveSqliteCoordinator,
  type SqliteCoordinatorLease,
} from "./sqlite-coordinator.js";

type Directory = { path: string; descriptor: number; identity: fs.BigIntStats };
type Marker = {
  owner: OwnedFileDescriptorSync;
  identity: fs.BigIntStats;
  parent: Directory;
  stage: string;
  target: string;
  native?: SqliteCoordinatorLease;
  published: boolean;
};

/** Creator-owned empty lock files are prepared privately and published no-clobber.
 * Their creation descriptor, not a later pathname lookup, establishes ownership.
 * Missing ancestors are blocked by a file too: no unreceipted directory creation
 * or adoption is necessary. The entire family stays held until final handback. */
export function createUpdateDatabaseAbsenceCustody() {
  const files = new DisposableStack();
  const directories = new Map<string, Directory>(),
    markers: Marker[] = [],
    reserved = new Set<string>();
  let released = false;
  const assertDirectory = (directory: Directory) => {
    if (
      !sameFileIdentity(fs.fstatSync(directory.descriptor, { bigint: true }), directory.identity)
    ) {
      throw new Error("Missing database reservation lost its parent descriptor");
    }
    assertDirectoryIdentitySync(directory.path, directory.identity);
  };
  const assertMarker = (marker: Marker, pathname: string) => {
    assertDirectory(marker.parent);
    const opened = fs.fstatSync(marker.owner.fd, { bigint: true }),
      current = fs.lstatSync(pathname, { bigint: true });
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.nlink !== 1n ||
      !sameFileIdentity(opened, marker.identity) ||
      !sameFileIdentity(opened, current) ||
      opened.size !== 0n ||
      marker.native?.closed ||
      (marker.published && !marker.native)
    ) {
      throw new Error("Missing database reservation changed: " + pathname);
    }
  };
  const currentName = (marker: Marker) => {
    if (marker.published) {
      return marker.target;
    }
    // Root.move may have renamed before reporting a later failure. Only the
    // original creation descriptor can identify either candidate as ours.
    for (const candidate of [marker.stage, marker.target]) {
      const stat = fs.lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
      if (stat && sameFileIdentity(stat, marker.identity)) {
        return candidate;
      }
    }
    throw new Error("Missing database reservation lost its created name");
  };
  const assertCurrent = () => {
    if (released) {
      throw new Error("Missing database reservations have already settled");
    }
    for (const directory of directories.values()) {
      assertDirectory(directory);
    }
    for (const marker of markers) {
      assertMarker(marker, currentName(marker));
    }
  };
  const covering = (pathname: string) =>
    markers.some((marker) => marker.published && pathname.startsWith(marker.target + path.sep));
  const pin = (pathname: string): Directory => {
    const held = directories.get(pathname);
    if (held) {
      assertDirectory(held);
      return held;
    }
    const descriptor = fs.openSync(
      pathname,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    let retained = false;
    return runWithSqliteCoordinator(
      {
        release: () => {
          if (!retained) {
            fs.closeSync(descriptor);
          }
        },
      },
      "Reservation parent admission",
      () => {
        const directory = {
          path: pathname,
          descriptor,
          identity: fs.fstatSync(descriptor, { bigint: true }),
        };
        assertDirectory(directory);
        directories.set(pathname, directory);
        retained = true;
        return directory;
      },
    );
  };
  const reserveName = async (pathname: string, assertAuthority: () => void) => {
    if (covering(pathname)) {
      assertCurrent();
      return;
    }
    let target = pathname;
    for (;;) {
      const parentPath = path.dirname(target),
        stat = fs.lstatSync(parentPath, { bigint: true, throwIfNoEntry: false });
      if (stat) {
        if (!stat.isDirectory()) {
          throw new Error("Reservation parent is not a directory: " + parentPath);
        }
        break;
      }
      target = parentPath;
    }
    const parent = pin(path.dirname(target));
    const stage = path.join(parent.path, ".sqlite-absence-" + randomUUID());
    const owner = createFileSync(stage, {
      private: true,
      assertBeforeMutation: () => {
        assertAuthority();
        assertCurrent();
        assertDirectory(parent);
      },
    });
    files.defer(() => owner.close());
    // Fstat the returned creator capability, never independently open/adopt the
    // current pathname. Record it before preparation so failures still settle it.
    const marker: Marker = {
      owner,
      identity: fs.fstatSync(owner.fd, { bigint: true }),
      parent,
      stage,
      target,

      published: false,
    };
    markers.push(marker);
    assertMarker(marker, stage);
    // Use the existing native lock primitive, not invalid-file sentinels: SQLite
    // may delete an invalid WAL during diagnosis. A real exclusive main-file
    // lock refuses peer admission before that cleanup can start. The private
    // stage uses MEMORY journaling, writes no rows and remains zero bytes.
    const native = tryAcquireExclusiveSqliteCoordinator(stage, {
      busyTimeoutMs: 0,
      keepAlive: false,
    });
    if (!native) {
      throw new Error("Could not acquire native absence reservation");
    }
    marker.native = native;
    assertMarker(marker, stage);
    const directory = await root(parent.path);
    await directory.move(path.basename(stage), path.basename(target), {
      overwrite: false,
      assertBeforeMutation: () => {
        assertAuthority();
        assertCurrent();
        assertMarker(marker, stage);
      },
    });
    marker.published = true;
    assertMarker(marker, target);
    fs.fsyncSync(parent.descriptor);
    assertCurrent();
  };
  return {
    has: (pathname: string) => reserved.has(pathname),
    coversParent: (pathname: string) => {
      assertCurrent();
      return covering(pathname);
    },
    assertCurrent,
    async reserve(pathname: string, assertAuthority: () => void) {
      assertAuthority();
      assertCurrent();
      if (reserved.has(pathname)) {
        return;
      }
      try {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          await reserveName(pathname + suffix, assertAuthority);
        }
        reserved.add(pathname);
      } catch (cause) {
        throw new Error(
          "Database restore native custody cannot reserve missing path: " + pathname,
          { cause },
        );
      }
    },
    [Symbol.dispose]() {
      if (released) {
        return;
      }
      released = true;
      const errors: unknown[] = [];
      // Synchronous final handback. Never traverse a directory or adopt a later
      // replacement; preserve changed identity, linkage or contents for recovery.
      for (const marker of markers.toReversed()) {
        try {
          const pathname = currentName(marker);
          assertMarker(marker, pathname);
          fs.unlinkSync(pathname);
          fs.fsyncSync(marker.parent.descriptor);
          assertDirectory(marker.parent);
        } catch (error) {
          errors.push(error);
        }
        try {
          marker.native?.release();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        files.dispose();
      } catch (error) {
        errors.push(error);
      }
      for (const directory of [...directories.values()].toReversed()) {
        try {
          fs.closeSync(directory.descriptor);
        } catch (error) {
          errors.push(error);
        }
      }
      throwSqliteLifecycleErrors(
        errors,
        "Missing database reservation settlement failed; preserve recovery artifacts",
      );
    },
  };
}
