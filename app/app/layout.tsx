import { LensShell } from "@/components/lens/LensShell";

/** The app segment: Report Lens with its sign-in bar. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <LensShell>{children}</LensShell>;
}
