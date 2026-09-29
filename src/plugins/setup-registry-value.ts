import { types } from "node:util";

export function cloneSetupRegistryValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const cached = seen.get(value);
  if (cached !== undefined) {
    // SAFETY: This traversal records each clone under the exact original object before recursing.
    return cached as T;
  }
  if (types.isDate(value)) {
    const clone = new Date(value);
    seen.set(value, clone);
    // SAFETY: The Date guard identifies this built-in value; new Date copies its timestamp.
    return clone as T;
  }
  if (types.isRegExp(value)) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    seen.set(value, clone);
    // SAFETY: The RegExp guard identifies this built-in value; source, flags, and lastIndex are preserved.
    return clone as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    clone.push(...value.map((entry) => cloneSetupRegistryValue(entry, seen)));
    // SAFETY: The array guard identifies the container; recursive clones preserve entry types and order.
    return clone as T;
  }
  if (types.isMap(value)) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);
    for (const [key, entry] of value.entries()) {
      clone.set(cloneSetupRegistryValue(key, seen), cloneSetupRegistryValue(entry, seen));
    }
    // SAFETY: The Map guard identifies the container; recursive clones preserve key and value types.
    return clone as T;
  }
  if (types.isSet(value)) {
    const clone = new Set<unknown>();
    seen.set(value, clone);
    for (const entry of value.values()) {
      clone.add(cloneSetupRegistryValue(entry, seen));
    }
    // SAFETY: The Set guard identifies the container; recursive clones preserve member types.
    return clone as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    // Class-prototyped values are shared by reference: setup registrations must
    // treat them as immutable, or a caller mutation corrupts later cache hits.
    return value;
  }
  const clone: object = Object.create(prototype);
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      descriptor.value = cloneSetupRegistryValue(descriptor.value, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  // SAFETY: The input prototype and all own descriptors are preserved, recursively cloning data values.
  return clone as T;
}
