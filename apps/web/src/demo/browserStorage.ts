function createEphemeralStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(String(key));
    },
    setItem: (key, value) => {
      values.set(String(key), String(value));
    },
  };
}

export function installDemoBrowserStorage(): void {
  // The app's existing stores can keep their interfaces without touching iframe storage.
  Object.defineProperties(window, {
    localStorage: { configurable: true, value: createEphemeralStorage() },
    sessionStorage: { configurable: true, value: createEphemeralStorage() },
  });
}
