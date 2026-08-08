"use client";

import { LabOverview } from "./_components/lab-overview";
import { useLabs } from "./_components/lab-provider";
import { Onboarding } from "./_components/onboarding";

export default function AppHome() {
  const { labs, currentLab } = useLabs();

  if (labs === undefined) {
    return <p className="font-sans text-sm text-ink-faint">Loading…</p>;
  }

  if (labs.length === 0 || currentLab === null) {
    return <Onboarding />;
  }

  return <LabOverview lab={currentLab} />;
}
