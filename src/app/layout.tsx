import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "VALORANT StatTrack",
    template: "%s · VALORANT StatTrack",
  },
  description: "Look up any VALORANT player's rank, recent competitive matches, and performance stats.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} flex min-h-dvh flex-col antialiased`}
      >
        <header className="border-b border-slate-800">
          <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3 text-sm">
            <Link href="/" className="font-semibold text-slate-100">
              VALORANT StatTrack
            </Link>
            <Link href="/leaderboard" className="text-slate-300 hover:text-slate-100">
              Leaderboard
            </Link>
          </nav>
        </header>
        <div className="flex flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}
