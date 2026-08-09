import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CommandPalette } from "./_components/command-palette";
import { LabProvider } from "./_components/lab-provider";
import { Sidebar } from "./_components/sidebar";
import { ToastProvider } from "./_components/toast";

export const metadata: Metadata = {
  title: "margin",
};

/**
 * The authenticated shell: a fixed left rail (wordmark, lab switcher, nav)
 * and a single content column. `middleware.ts` guarantees there is a session
 * by the time anything here renders; the Convex functions re-check anyway.
 *
 * `ToastProvider` sits around the whole shell, not just the content column:
 * the rail acts on the lab too, and an undo has to outlive the surface that
 * offered it. This file stays a server component — the provider carries its
 * own `"use client"`, so `children` is still rendered on the server and passed
 * through it as a slot.
 *
 * `CommandPalette` is mounted here for the same reason and inside the same
 * provider: ⌘K has to answer from every screen, and a command that reports
 * what it did does it through a toast.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <LabProvider>
      <ToastProvider>
        <div className="flex min-h-screen flex-col bg-page md:flex-row">
          <Sidebar />
          <main className="min-w-0 flex-1 px-6 py-10 sm:px-10 md:py-12">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </main>
        </div>
        <CommandPalette />
      </ToastProvider>
    </LabProvider>
  );
}
