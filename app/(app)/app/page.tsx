"use client";

import { LabOverview } from "./_components/lab-overview";
import { useLabs } from "./_components/lab-provider";
import { Onboarding } from "./_components/onboarding";
import { PageSkeleton } from "./_components/skeletons";

export default function AppHome() {
  const { labs, currentLab } = useLabs();

  if (labs === undefined) {
    return <PageSkeleton />;
  }

  if (labs.length === 0 || currentLab === null) {
    return <Onboarding />;
  }

  return <LabOverview lab={currentLab} />;
}
