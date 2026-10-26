import { redirect } from "next/navigation";

/** /app is Report Lens. */
export default function AppHome() {
  redirect("/app/lens");
}
