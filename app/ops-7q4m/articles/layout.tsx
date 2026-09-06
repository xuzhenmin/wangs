import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "文章列表管理｜深巷后台",
  description: "管理文章列表、发布状态和访问统计。",
  robots: { index: false, follow: false },
};

export default function ArticleManagementLayout({ children }: { children: React.ReactNode }) {
  return children;
}
