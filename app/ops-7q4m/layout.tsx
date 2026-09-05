import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "授权位置总览｜深巷后台",
  description: "深巷超级管理员授权位置管理后台。",
  robots: { index: false, follow: false },
  openGraph: {
    title: "授权位置总览｜深巷后台",
    description: "深巷超级管理员授权位置管理后台。",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "授权位置总览｜深巷后台",
    description: "深巷超级管理员授权位置管理后台。",
  },
};

export default function OperationsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
