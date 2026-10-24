import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MUSD Guardian — Mezo Testnet loan health",
  description:
    "Check the health of a Bitcoin-backed MUSD loan on Mezo Testnet before liquidation does.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
