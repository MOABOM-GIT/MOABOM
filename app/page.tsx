"use client";

import { useRef, useEffect, useState } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";
import { getOrCreateUserProfile, saveMeasurement, getLatestMeasurement, type MeasureLog } from "@/lib/supabase";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("준비 완료");
  const [user, setUser] = useState<MoabomUser | null>(null);
  const [latestMeasurement, setLatestMeasurement] = useState<MeasureLog | null>(null);
  const [isMeasuring, setIsMeasuring] = useState(false);

  // 컴포넌트 마운트 시 사용자 정보 가져오기
  useEffect(() => {
    const initUser = async () => {
      const moabomUser = getMoabomUser();
      if (moabomUser) {
        setUser(moabomUser);
        setStatus(`환영합니다, ${moabomUser.mb_nick}님!`);
        console.log('[MoabomAuth] User info:', moabomUser);

        // Supabase에 사용자 프로필 생성/확인
        await getOrCreateUserProfile(
          moabomUser.mb_id,
          moabomUser.mb_nick,
          moabomUser.mb_email
        );

        // 최근 측정 기록 가져오기
        const latest = await getLatestMeasurement(moabomUser.mb_id);
        if (latest) {
          setLatestMeasurement(latest);
          setStatus(`마지막 측정: ${latest.recommended_size || '기록 없음'}`);
        }
      } else {
        setStatus("로그인이 필요합니다");
      }
    };

    initUser();
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
        setIsMeasuring(true);
      }
    } catch (err) {
      console.error("카메라 접근 에러:", err);
      setStatus("에러: 카메라 권한을 허용해주세요.");
    }
  };

  // 테스트용 측정 저장 함수
  const saveDummyMeasurement = async () => {
    if (!user) return;

    setStatus("측정 결과 저장 중...");

    const result = await saveMeasurement({
      user_id: user.mb_id,
      user_name: user.mb_nick,
      nose_width: 35.5,
      face_length: 180.2,
      chin_angle: 120.5,
      recommended_size: "M",
      measurement_data: {
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      },
    });

    if (result.success) {
      setStatus("측정 완료! 추천 사이즈: M");
      setLatestMeasurement(result.data!);
      
      // 모아봄에 결과 전달 (PostMessage)
      window.parent.postMessage({
        type: 'MEASUREMENT_COMPLETE',
        data: result.data
      }, '*');
    } else {
      setStatus("저장 실패. 다시 시도해주세요.");
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
          {latestMeasurement && (
            <div className="mt-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">
                최근 측정 결과
              </p>
              <p className="text-xs text-zinc-600 dark:text-zinc-300">
                추천 사이즈: {latestMeasurement.recommended_size}
              </p>
              <p className="text-xs text-zinc-400">
                {new Date(latestMeasurement.created_at!).toLocaleDateString('ko-KR')}
              </p>
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
        <div className="space-y-3">
          <button
            onClick={startCamera}
            disabled={!user || isMeasuring}
            className="w-full rounded-xl bg-blue-600 px-8 py-4 text-lg font-bold text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isMeasuring ? "측정 중..." : "측정 시작하기"}
          </button>

          {/* 테스트용 버튼 */}
          {isMeasuring && (
            <button
              onClick={saveDummyMeasurement}
              className="w-full rounded-xl bg-green-600 px-8 py-3 text-sm font-bold text-white transition-transform hover:scale-105 active:scale-95"
            >
              테스트: 측정 결과 저장
            </button>
          )}
        </div>

        <p className="text-xs text-zinc-400">
          본 프로그램은 3D 안면 분석을 통해 최적의 양압기 마스크를 추천합니다.
        </p>
      </div>
    </div>
  );
}