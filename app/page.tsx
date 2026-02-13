"use client";

import { useRef, useEffect, useState } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("준비 완료");
  const [user, setUser] = useState<MoabomUser | null>(null);

  // 컴포넌트 마운트 시 사용자 정보 가져오기
  useEffect(() => {
    const moabomUser = getMoabomUser();
    if (moabomUser) {
      setUser(moabomUser);
      setStatus(`환영합니다, ${moabomUser.mb_nick}님!`);
      console.log('[MoabomAuth] User info:', moabomUser);
    } else {
      setStatus("로그인이 필요합니다");
    }
  }, []);

  const startCamera = async () => {
    if (!user) {
      setStatus("에러: 로그인이 필요합니다");
      return;
    }

    setStatus("카메라 연결 중...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: "user" } // 전면 카메라 우선
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setStatus("카메라 작동 중 - 얼굴을 비춰주세요");
      }
    } catch (err) {
      console.error("카메라 접근 에러:", err);
      setStatus("에러: 카메라 권한을 허용해주세요.");
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white p-4 dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-6 text-center">
        {/* 헤더 부분 */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tighter text-blue-600">MOABOM AI Vision</h1>
          <p className="text-zinc-500 dark:text-zinc-400">{status}</p>
          {user && (
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              <p>사용자: {user.mb_nick} ({user.mb_id})</p>
              <p className="text-xs text-zinc-400">레벨: {user.mb_level}</p>
            </div>
          )}
        </div>

        {/* 비디오 화면 공간 */}
        <div className="relative aspect-video overflow-hidden rounded-2xl border-4 border-blue-500 bg-black shadow-xl">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-cover"
          />
          {/* 가이드 라인 (나중에 여기 3D 메쉬가 그려질 거예요) */}
          <div className="absolute inset-0 border-2 border-dashed border-white/30 pointer-events-none flex items-center justify-center">
            <div className="w-48 h-64 border-2 border-blue-400/50 rounded-[100px]"></div>
          </div>
        </div>

        {/* 컨트롤 버튼 */}
        <button
          onClick={startCamera}
          disabled={!user}
          className="w-full rounded-xl bg-blue-600 px-8 py-4 text-lg font-bold text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          측정 시작하기
        </button>

        <p className="text-xs text-zinc-400">
          본 프로그램은 3D 안면 분석을 통해 최적의 양압기 마스크를 추천합니다.
        </p>
      </div>
    </div>
  );
}