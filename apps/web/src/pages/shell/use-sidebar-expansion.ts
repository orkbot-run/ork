import { useCallback, useEffect, useState } from "react";
import { safeLocalStorage } from "../../lib/storage";

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `orkbot:collapsed-sidebar-sections:${userId}`;
}

function readCollapsedIdSet(storageKey: string | null): Set<string> {
  if (!storageKey) return new Set();
  try {
    const value = safeLocalStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function toggleCollapsedIdSet(
  previous: ReadonlySet<string>,
  id: string,
  storageKey: string | null,
): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (storageKey) {
    try {
      safeLocalStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Keep the UI usable when storage is unavailable.
    }
  }
  return next;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedSidebarSectionsStorageKey(userId));
}

export function useSidebarExpansion(userId: string | null | undefined) {
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
  }, [userId]);
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) =>
        toggleCollapsedIdSet(previous, key, collapsedSidebarSectionsStorageKey(userId)),
      );
    },
    [userId],
  );
  return {
    collapsedSidebarSections,
    toggleSidebarSection,
  };
}
