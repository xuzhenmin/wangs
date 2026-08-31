import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  return {
    title: "深巷｜景甜张继科地下恋红娘事件时间线",
    description: "娱乐圈女演员景甜、张继科地下恋红娘事件及时间线全曝光，任嘉伦被指是真正牵线人。",
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "深巷｜景甜张继科地下恋红娘事件时间线",
      description: "景甜、张继科地下恋时间线及任嘉伦牵线人传闻梳理。",
      type: "website",
    },
    twitter: { card: "summary", title: "深巷｜景甜张继科地下恋红娘事件时间线", description: "景甜、张继科地下恋时间线及任嘉伦牵线人传闻梳理。" },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
