"use client";

import { useEffect, useState } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";
import Link from "next/link";

export default function Home() {
  const [user, setUser] = useState<MoabomUser | null>(null);

  useEffect(() => {
    const moabomUser = getMoabomUser();
    if (moabomUser) {
      setUser(moabomUser);
    }
  }, []);

  const apps = [
    {
      id: 'cpap-mask',
      name: 'CPAP 마스크 측정',
      description: '3D 안면 분석을 통한 양압기 마스크 사이즈 추천',
      icon: '🎭',
      path: '/cpap-mask',
      color: 'from-blue-600 to-indigo-600'
    },
    // 여기에 새로운 앱 추가
    // {
    //   id: 'app2',
    //   name: '앱 이름',
    //   description: '앱 설명',
    //   icon: '🚀',
    //   path: '/app2',
    //   color: 'from-green-600 to-emerald-600'
    // },
  ];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-zinc-50 to-zinc-100 p-4 dark:from-zinc-900 dark:to-zinc-950">
      <div className="w-full max-w-6xl space-y-8">
        {/* 헤더 */}
        <div className="text-center space-y-4">
          <h1 className="text-5xl font-bold tracking-tighter bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
            MOABOM AI Platform
          </h1>
          <p className="text-lg text-zinc-600 dark:text-zinc-400">
            AI 기반 비즈니스 솔루션 플랫폼
          </p>
          {user && (
            <div className="text-sm text-zinc-500">
              환영합니다, {user.mb_nick}님
            </div>
          )}
        </div>

        {/* 앱 그리드 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {apps.map((app) => (
            <Link
              key={app.id}
              href={app.path}
              className="group relative overflow-hidden rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-lg transition-all hover:shadow-2xl hover:scale-105"
            >
              {/* 배경 그라데이션 */}
              <div className={`absolute inset-0 bg-gradient-to-br ${app.color} opacity-0 group-hover:opacity-10 transition-opacity`} />
              
              {/* 콘텐츠 */}
              <div className="relative space-y-4">
                <div className="text-5xl">{app.icon}</div>
                <div>
                  <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                    {app.name}
                  </h3>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-2">
                    {app.description}
                  </p>
                </div>
                <div className={`inline-flex items-center text-sm font-semibold bg-gradient-to-r ${app.color} bg-clip-text text-transparent`}>
                  시작하기 →
                </div>
              </div>
            </Link>
          ))}
        </div>

        {/* 푸터 */}
        <div className="text-center text-xs text-zinc-500 pt-8">
          © 2024 MOABOM. All rights reserved.
        </div>
      </div>
    </div>
  );
}
