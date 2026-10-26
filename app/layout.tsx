import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ade-lens — Report Lens",
  description:
    "A Power BI report with an agent beside it that sees what you see, answers from the model as you, and can drive the report when you ask.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
