import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "深巷｜城市观察与同城报道",
    description: "记录街巷，也尊重每一个生活其中的人。",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "深巷｜城市观察与同城报道",
      description: "街道会说话，我们负责听见。",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1731, height: 909, alt: "深巷城市观察与同城报道" }],
    },
    twitter: { card: "summary_large_image", title: "深巷｜城市观察与同城报道", description: "街道会说话，我们负责听见。", images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
