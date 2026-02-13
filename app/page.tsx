"use client";

import { useRef, useEffect, useState } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";
import { getOrCreateUserProfile, saveMeasurement, getLatestMeasurement, type MeasureLog } from "@/lib/supabase";
import { FaceLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { performMeasurement, recommendMaskSize, drawLandmarks, type FaceMeasurements } from "@/lib/face-measurement";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("준비 완료");
  const [user, setUser] = useState<MoabomUser | null>(null);
  const [latestMeasurement, setLatestMeasurement] = useState<MeasureLog | null>(null);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [currentMeasurements, setCurrentMeasurements] = useState<FaceMeasurements | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // MediaPipe 초기화
  useEffect(() => {
    const initMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
        });
        
        setFaceLandmarker(landmarker);
        console.log('[MediaPipe] Face Landmarker initialized');
      } catch (error) {
        console.error('[MediaPipe] Initialization error:', error);
        setStatus("에러: MediaPipe 초기화 실패");
      }
    };

    initMediaPipe();
  }, []);

  // 사용자 정보 초기화
  useEffect(() => {
    const initUser = async () => {
      const moabomUser = getMoabomUser();
      if (moabomUser) {
        setUser(moabomUser);
        setStatus(`환영합니다, ${moabomUser.mb_nick}님!`);
        
        await getOrCreateUserProfile(
          moabomUser.mb_id,
          moabomUser.mb_nick,
          moabomUser.mb_email
        );

        const latest = await getLatestMeasurement(moabomUser.mb_id);
        if (latest) {
          setLatestMeasurement(latest);
        }
      } else {
        setStatus("로그인이 필요합니다");
      }
    };

    initUser();
  }, []);

  // 실시간 얼굴 감지 및 측정
  const detectFace = async () => {
    if (!videoRef.current || !canvasRef.current || !faceLandmarker || !isMeasuring) {
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    if (!ctx || video.readyState !== 4) {
      animationFrameRef.current = requestAnimationFrame(detectFace);
      return;
    }

    // 캔버스 크기 설정
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // 비디오 프레임 분석
    const startTimeMs = performance.now();
    const results = faceLandmarker.detectForVideo(video, startTimeMs);

    // 캔버스 클리어
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      // 랜드마크 그리기
      drawLandmarks(ctx, results.faceLandmarks[0], canvas.width, canvas.height);

      // 측정 수행
      const measurements = performMeasurement(results);
      if (measurements) {
        setCurrentMeasurements(measurements);
        setStatus(`측정 중... 코: ${measurements.noseWidth}mm | 얼굴: ${measurements.faceLength}mm`);
      }
    } else {
      setStatus("얼굴을 찾을 수 없습니다. 카메라를 정면으로 봐주세요.");
    }

    animationFrameRef.current = requestAnimationFrame(detectFace);
  };

  const startCamera = async () => {
    if (!user) {
      setStatus("에러: 로그인이 필요합니다");
      return;
    }

    if (!faceLandmarker) {
      setStatus("에러: MediaPipe 로딩 중...");
      return;
    }

    setStatus("카메라 연결 중...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play();
          setIsMeasuring(true);
          setStatus("얼굴을 정면으로 봐주세요");
          detectFace();
        };
      }
    } catch (err) {
      console.error("카메라 접근 에러:", err);
      setStatus("에러: 카메라 권한을 허용해주세요.");
    }
  };

  const stopCamera = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }

    setIsMeasuring(false);
    setCurrentMeasurements(null);
    setStatus("측정 중지됨");
  };

  const saveMeasurementResult = async () => {
    if (!user || !currentMeasurements) return;

    setStatus("측정 결과 저장 중...");

    const recommendedSize = recommendMaskSize(currentMeasurements);

    const result = await saveMeasurement({
      user_id: user.mb_id,
      user_name: user.mb_nick,
      nose_width: currentMeasurements.noseWidth,
      face_length: currentMeasurements.faceLength,
      chin_angle: currentMeasurements.chinAngle,
      recommended_size: recommendedSize,
      measurement_data: {
        timestamp: new Date().toISOString(),
        confidence: currentMeasurements.confidence,
        ipd_pixels: currentMeasurements.ipdPixels,
        scale_factor: currentMeasurements.scaleFactor,
      },
    });

    if (result.success) {
      setStatus(`측정 완료! 추천 사이즈: ${recommendedSize}`);
      setLatestMeasurement(result.data!);
      
      // 모아봄에 결과 전달
      window.parent.postMessage({
        type: 'MEASUREMENT_COMPLETE',
        data: result.data
      }, '*');

      stopCamera();
    } else {
      setStatus("저장 실패. 다시 시도해주세요.");
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4 dark:from-zinc-900 dark:to-zinc-950">
      <div className="w-full max-w-2xl space-y-6">
        {/* 헤더 */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tighter bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
            MOABOM AI Vision
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
          {user && (
            <div className="text-xs text-zinc-500">
              {user.mb_nick} ({user.mb_id})
            </div>
          )}
        </div>

        {/* 비디오 + 캔버스 */}
        <div className="relative aspect-video overflow-hidden rounded-2xl border-4 border-blue-500 bg-black shadow-2xl">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
          />
          
          {/* 측정 정보 오버레이 */}
          {currentMeasurements && (
            <div className="absolute top-4 left-4 bg-black/70 text-white p-3 rounded-lg text-xs space-y-1">
              <div>코 너비: <span className="font-bold">{currentMeasurements.noseWidth}mm</span></div>
              <div>얼굴 길이: <span className="font-bold">{currentMeasurements.faceLength}mm</span></div>
              <div>턱 각도: <span className="font-bold">{currentMeasurements.chinAngle}°</span></div>
              <div className="pt-2 border-t border-white/30">
                추천: <span className="font-bold text-green-400">{recommendMaskSize(currentMeasurements)} 사이즈</span>
              </div>
            </div>
          )}
        </div>

        {/* 최근 측정 결과 */}
        {latestMeasurement && !isMeasuring && (
          <div className="p-4 bg-white dark:bg-zinc-800 rounded-xl shadow-lg">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">최근 측정 결과</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>추천 사이즈: <span className="font-bold text-blue-600">{latestMeasurement.recommended_size}</span></div>
              <div>코 너비: {latestMeasurement.nose_width}mm</div>
              <div>얼굴 길이: {latestMeasurement.face_length}mm</div>
              <div>측정일: {new Date(latestMeasurement.created_at!).toLocaleDateString('ko-KR')}</div>
            </div>
          </div>
        )}

        {/* 컨트롤 버튼 */}
        <div className="flex gap-3">
          {!isMeasuring ? (
            <button
              onClick={startCamera}
              disabled={!user || !faceLandmarker}
              className="flex-1 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-8 py-4 text-lg font-bold text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
            >
              {faceLandmarker ? "측정 시작" : "로딩 중..."}
            </button>
          ) : (
            <>
              <button
                onClick={saveMeasurementResult}
                disabled={!currentMeasurements}
                className="flex-1 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 px-8 py-4 text-lg font-bold text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 shadow-lg"
              >
                결과 저장
              </button>
              <button
                onClick={stopCamera}
                className="flex-1 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 px-8 py-4 text-lg font-bold text-white transition-transform hover:scale-105 active:scale-95 shadow-lg"
              >
                중지
              </button>
            </>
          )}
        </div>

        <p className="text-xs text-center text-zinc-500">
          3D 안면 분석을 통해 최적의 양압기 마스크를 추천합니다
        </p>
      </div>
    </div>
  );
}