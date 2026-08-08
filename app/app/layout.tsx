import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LabProvider } from "./_components/lab-provider";
import { Sidebar } from "./_components/sidebar";

export const metadata: Metadata = {
  title: "margin",
};

/**
 * The authenticated shell: a fixed left rail (wordmark, lab switcher, nav)
 * and a single content column. `middleware.ts` guarantees there is a session
 * by the time anything here renders; the Convex functions re-check anyway.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <LabProvider>
      <div className="flex min-h-screen flex-col bg-page md:flex-row">
        <Sidebar />
        <main className="min-w-0 flex-1 px-6 py-10 sm:px-10 md:py-12">
          <div className="mx-auto w-full max-w-3xl">{children}</div>
        </main>
      </div>
    </LabProvider>
  );
}
