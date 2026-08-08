"use client";

import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type LabSummary = FunctionReturnType<typeof api.labs.getMyLabs>[number];

type LabContextValue = {
  /** `undefined` while the first query is in flight. */
  labs: LabSummary[] | undefined;
  currentLab: LabSummary | null;
  selectLab: (labId: LabSummary["_id"]) => void;
};

const LabContext = createContext<LabContextValue | null>(null);

const STORAGE_KEY = "margin.currentLabId";

/**
 * Which lab you are looking at is a client-side concern for now — one route
 * (`/app`) renders whichever lab is selected. It is remembered across reloads
 * so a two-lab postdoc doesn't have to re-pick every morning. When the reader
 * and sessions arrive this becomes a real route segment.
 */
export function LabProvider({ children }: { children: ReactNode }) {
  const labs = useQuery(api.labs.getMyLabs);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(window.localStorage.getItem(STORAGE_KEY));
  }, []);

  const selectLab = useCallback((labId: LabSummary["_id"]) => {
    setSelectedId(labId);
    window.localStorage.setItem(STORAGE_KEY, labId);
  }, []);

  const currentLab =
    labs?.find((lab) => lab._id === selectedId) ?? labs?.[0] ?? null;

  return (
    <LabContext.Provider value={{ labs, currentLab, selectLab }}>
      {children}
    </LabContext.Provider>
  );
}

export function useLabs(): LabContextValue {
  const value = useContext(LabContext);
  if (value === null) {
    throw new Error("useLabs must be used inside the /app layout.");
  }
  return value;
}
