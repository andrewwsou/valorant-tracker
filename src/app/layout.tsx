import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SiteNav from "@/components/site_nav";
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="flex min-h-dvh flex-col antialiased">
        <SiteNav />
        <div className="flex flex-1 flex-col">{children}</div>
        <footer className="border-t border-white/8 px-6 py-5 text-center text-xs text-slate-500">
          Match data from the HenrikDev API. Not affiliated with or endorsed by Riot Games.
        </footer>
      </body>
    </html>
  );
}
