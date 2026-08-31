import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3217";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "深巷｜景甜张继科地下恋红娘事件时间线",
    description: "娱乐圈女演员景甜、张继科地下恋红娘事件及时间线全曝光，任嘉伦被指是真正牵线人。",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "深巷｜景甜张继科地下恋红娘事件时间线",
      description: "景甜、张继科地下恋时间线及任嘉伦牵线人传闻梳理。",
      type: "website",
      images: [{ url: `${origin}/scraped-article/article-image.png`, width: 464, height: 120, alt: "景甜张继科地下恋红娘事件文章配图" }],
    },
    twitter: { card: "summary_large_image", title: "深巷｜景甜张继科地下恋红娘事件时间线", description: "景甜、张继科地下恋时间线及任嘉伦牵线人传闻梳理。", images: [`${origin}/scraped-article/article-image.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
