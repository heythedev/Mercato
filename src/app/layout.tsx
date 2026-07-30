import type { Metadata } from "next";
import { Geist, Geist_Mono, Bitcount_Single } from "next/font/google";
import { Toaster } from "sonner";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const brandFont = Bitcount_Single({ variable: "--font-brand", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mercato",
  description: "Multi-marketplace product sourcing & verification",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${brandFont.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ConfirmProvider>
            {children}
            <Toaster richColors position="top-center" />
          </ConfirmProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
