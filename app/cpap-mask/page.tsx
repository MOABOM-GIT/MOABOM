"use client";

import { useRef, useEffect, useState } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";
import { getOrCreateUserProfile, saveMeasurement, getLatestMeasurement, type MeasureLog } from "@/lib/supabase";
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  performMeasurement,
  recommendMaskSize,
  drawLandmarks,
  type FaceMeasurements,
  estimateYaw,
  performProfileMeasurement,
  type ProfileMeasurements,
  isFaceSizeValidForMeasurement,
  isFaceLengthInRange,
} from "@/lib/face-measurement";

type MeasurementStep = 'idle' | 'preparing' | 'countdown' | 'scanning_front' | 'turn_side' | 'scanning_side' | 'complete';

const COUNTDOWN_DURATION = 3;
const SCAN_FRAMES = 90;
const STABLE_FRAMES_REQUIRED = 20;
const YAW_FRONT_THRESHOLD = 10;
const YAW_SIDE_THRESHOLD = 35;

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number>(0);
  
  // 측정 데이터 버퍼
  const frontDataRef = useRef<FaceMeasurements[]>([]);
  const sideDataRef = useRef<ProfileMeasurements[]>([]);
  const stableFrameCountRef = useRef(0);
  const fixedScaleFactorRef = useRef<number>(0);

  // 상태
  const [step, setStep] = useState<MeasurementStep>('idle');
  const [status, setStatus] = useState("준비 완료");
  const [subStatus, setSubStatus] = useState("");
  const [user, setUser] = useState<MoabomUser | null>(null);
  const [latestMeasurement, setLatestMeasurement] = useState<MeasureLog | null>(null);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN_DURATION);
  const [scanProgress, setScanProgress] = useState(0);
  const [finalResult, setFinalResult] = useState<{
    front: FaceMeasurements;
    side: ProfileMeasurements;
  } | null>(null);

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
      } catch (error) {
        console.error('[MediaPipe] 초기화 실패:', error);
        setStatus("에러: AI 모델 로딩 실패");
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
          moabomUser.mb_email,
          moabomUser.mb_nick
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

  // 카운트다운 처리
  useEffect(() => {
    if (step === 'countdown') {
      let count = COUNTDOWN_DURATION;
      setCountdown(count);
      
      const timer = setInterval(() => {
        count--;
        setCountdown(count);
        
        if (count === 0) {
          clearInterval(timer);
          setStep('scanning_front');
          frontDataRef.current = [];
          setScanProgress(0);
        }
      }, 1000);
      
      return () => clearInterval(timer);
    }
  }, [step]);

  // 얼굴 감지 루프
  useEffect(() => {
    if (step !== 'idle' && step !== 'complete' && faceLandmarker && videoRef.current) {
      detectFace();
    }
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [step, faceLandmarker]);

  const detectFace = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (!video || !canvas || !faceLandmarker || video.readyState < 2) {
      animationFrameRef.current = requestAnimationFrame(detectFace);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      animationFrameRef.current = requestAnimationFrame(detectFace);
      return;
    }

    // 캔버스 크기 설정
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 타임스탬프 관리 (단조 증가)
    const now = performance.now();
    const timestamp = Math.max(lastTimestampRef.current + 1, now);
    lastTimestampRef.current = timestamp;

    // 얼굴 감지
    const results = faceLandmarker.detectForVideo(video, timestamp);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      const landmarks = results.faceLandmarks[0];
      drawLandmarks(ctx, landmarks, canvas.width, canvas.height);

      const measurements = performMeasurement(results);
      if (measurements) {
        const yaw = estimateYaw(landmarks);
        handleMeasurementStep(measurements, yaw, landmarks);
      }
    } else {
      handleNoFace();
    }

    animationFrameRef.current = requestAnimationFrame(detectFace);
  };

  const handleMeasurementStep = (
    measurements: FaceMeasurements,
    yaw: number,
    landmarks: any[]
  ) => {
    switch (step) {
      case 'preparing':
        // 정면 자세 확인
        if (Math.abs(yaw) < YAW_FRONT_THRESHOLD) {
          if (!isFaceSizeValidForMeasurement(measurements)) {
            stableFrameCountRef.current = 0;
            setSubStatus("얼굴을 가이드에 맞춰 가까이 해주세요");
            return;
          }
          
          stableFrameCountRef.current++;
          setSubStatus(`자세 확인 중... ${Math.min(stableFrameCountRef.current, STABLE_FRAMES_REQUIRED)}/${STABLE_FRAMES_REQUIRED}`);
          
          if (stableFrameCountRef.current >= STABLE_FRAMES_REQUIRED) {
            setStatus("측정을 시작합니다");
            setSubStatus("");
            setStep('countdown');
            stableFrameCountRef.current = 0;
          }
        } else {
          stableFrameCountRef.current = 0;
          setSubStatus("정면을 봐주세요");
        }
        break;

      case 'scanning_front':
        // 정면 데이터 수집
        frontDataRef.current.push(measurements);
        const frontProgress = Math.min(100, Math.round((frontDataRef.current.length / SCAN_FRAMES) * 100));
        setScanProgress(frontProgress);
        setStatus("정면 스캔 중");
        setSubStatus(`${frontProgress}% 완료`);
        
        if (frontDataRef.current.length >= SCAN_FRAMES) {
          // 평균 스케일 팩터 계산
          const avgScale = frontDataRef.current.reduce((sum, m) => sum + m.scaleFactor, 0) / frontDataRef.current.length;
          fixedScaleFactorRef.current = avgScale;
          
          setStep('turn_side');
          setStatus("측면 측정 준비");
          setSubStatus("고개를 천천히 옆으로 돌려주세요");
          setScanProgress(0);
          stableFrameCountRef.current = 0;
        }
        break;

      case 'turn_side':
        // 측면 자세 확인
        if (Math.abs(yaw) > YAW_SIDE_THRESHOLD) {
          stableFrameCountRef.current++;
          
          if (stableFrameCountRef.current >= 10) {
            setStep('scanning_side');
            sideDataRef.current = [];
            stableFrameCountRef.current = 0;
          }
        } else {
          stableFrameCountRef.current = 0;
        }
        break;

      case 'scanning_side':
        // 측면 데이터 수집
        const sideData = performProfileMeasurement(landmarks, fixedScaleFactorRef.current);
        sideDataRef.current.push(sideData);
        
        const sideProgress = Math.min(100, Math.round((sideDataRef.current.length / SCAN_FRAMES) * 100));
        setScanProgress(sideProgress);
        setStatus("측면 스캔 중");
        setSubStatus(`${sideProgress}% 완료`);
        
        if (sideDataRef.current.length >= SCAN_FRAMES) {
          completeMeasurement();
        }
        break;
    }
  };

  const handleNoFace = () => {
    if (step === 'preparing' || step === 'turn_side') {
      setSubStatus("얼굴을 찾을 수 없습니다");
      stableFrameCountRef.current = 0;
    }
  };

  const completeMeasurement = () => {
    // 평균값 계산
    const avgFront = calculateAverage(frontDataRef.current);
    const avgSide = calculateAverageSide(sideDataRef.current);
    
    setFinalResult({ front: avgFront, side: avgSide });
    setStep('complete');
    setStatus("측정 완료");
    setSubStatus("결과를 확인하고 저장하세요");
    
    // 카메라 정지
    stopCamera();
  };

  const calculateAverage = (data: FaceMeasurements[]): FaceMeasurements => {
    if (data.length === 0) {
      return { noseWidth: 0, faceLength: 0, chinAngle: 0, ipdPixels: 0, scaleFactor: 0, confidence: 0 };
    }
    
    const sum = data.reduce((acc, cur) => ({
      noseWidth: acc.noseWidth + cur.noseWidth,
      faceLength: acc.faceLength + cur.faceLength,
      chinAngle: acc.chinAngle + cur.chinAngle,
      ipdPixels: acc.ipdPixels + cur.ipdPixels,
      scaleFactor: acc.scaleFactor + cur.scaleFactor,
      confidence: acc.confidence
    }), { noseWidth: 0, faceLength: 0, chinAngle: 0, ipdPixels: 0, scaleFactor: 0, confidence: 0 });
    
    const count = data.length;
    return {
      noseWidth: Math.round(sum.noseWidth / count * 10) / 10,
      faceLength: Math.round(sum.faceLength / count * 10) / 10,
      chinAngle: Math.round(sum.chinAngle / count * 10) / 10,
      ipdPixels: sum.ipdPixels / count,
      scaleFactor: sum.scaleFactor / count,
      confidence: 0.95
    };
  };

  const calculateAverageSide = (data: ProfileMeasurements[]): ProfileMeasurements => {
    if (data.length === 0) return { noseHeight: 0, faceDepth: 0 };
    
    const sum = data.reduce((acc, cur) => ({
      noseHeight: acc.noseHeight + cur.noseHeight,
      faceDepth: acc.faceDepth + cur.faceDepth
    }), { noseHeight: 0, faceDepth: 0 });
    
    const count = data.length;
    return {
      noseHeight: Math.round(sum.noseHeight / count * 10) / 10,
      faceDepth: Math.round(sum.faceDepth / count * 10) / 10
    };
  };

  const startCamera = async () => {
    if (!user) {
      setStatus("에러: 로그인이 필요합니다");
      return;
    }

    if (!faceLandmarker) {
      setStatus("에러: AI 모델 로딩 중...");
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
        videoRef.current.onloadedmetadata = async () => {
          try {
            await videoRef.current?.play();
            setStep('preparing');
            setStatus("카메라를 정면으로 봐주세요");
            setSubStatus("얼굴을 가이드에 맞춰주세요");
            lastTimestampRef.current = 0;
          } catch (err) {
            console.error("비디오 재생 실패:", err);
            setStatus("비디오 재생 권한이 필요합니다");
          }
        };
      }
    } catch (err: any) {
      console.error("카메라 접근 에러:", err);
      setStatus(`에러: 카메라 권한을 허용해주세요`);
    }
  };

  const stopCamera = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
  };

  const handleSave = async () => {
    if (!user || !finalResult) return;

    setStatus("저장 중...");

    const recommendedSize = recommendMaskSize(finalResult.front);

    const measurementData = {
      user_id: user.mb_id,
      user_name: user.mb_nick,
      nose_width: finalResult.front.noseWidth,
      face_length: finalResult.front.faceLength,
      chin_angle: finalResult.front.chinAngle,
      recommended_size: recommendedSize,
      measurement_data: {
        timestamp: new Date().toISOString(),
        confidence: finalResult.front.confidence,
        profile: finalResult.side,
      },
    };

    const result = await saveMeasurement(measurementData);

    if (result.success) {
      setStatus(`측정 완료! 추천 사이즈: ${recommendedSize}`);
      setLatestMeasurement(result.data!);
      
      window.parent.postMessage({
        type: 'MEASUREMENT_COMPLETE',
        data: result.data
      }, '*');
    } else {
      setStatus(`저장 실패: ${result.error?.message || '알 수 없는 오류'}`);
      console.error('[Save] Error:', result.error);
    }
  };

  const handleRetry = () => {
    setStep('idle');
    setFinalResult(null);
    setScanProgress(0);
    frontDataRef.current = [];
    sideDataRef.current = [];
    stableFrameCountRef.current = 0;
    setStatus("준비 완료");
    setSubStatus("");
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black">
      <div className="relative w-full h-screen max-w-md mx-auto bg-gray-900 shadow-2xl overflow-hidden">
        {/* 비디오 & 캔버스 */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
            step === 'idle' ? 'opacity-0' : 'opacity-100'
          }`}
          style={{ transform: 'scaleX(-1)' }}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: 'scaleX(-1)' }}
        />

        {/* IDLE 화면 */}
        {step === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-gray-800 to-black">
            <h1 className="text-3xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
              SmartCare AI
            </h1>
            <p className="text-gray-400 mb-8 text-center max-w-xs">
              정확한 양압기 마스크 추천을 위해<br />3D 안면 분석을 시작합니다
            </p>
            
            <div className="space-y-4 w-full max-w-xs">
              <div className="bg-gray-800/50 p-4 rounded-xl border border-gray-700">
                <h3 className="text-sm font-semibold text-gray-300 mb-2">측정 가이드</h3>
                <ul className="text-xs text-gray-400 space-y-2 list-disc pl-4">
                  <li>밝은 곳에서 촬영해주세요</li>
                  <li>모자나 안경을 벗어주세요</li>
                  <li>정면과 측면 측정이 진행됩니다</li>
                  <li>얼굴을 가이드에 맞춰주세요</li>
                </ul>
              </div>

              <button
                onClick={startCamera}
                disabled={!user || !faceLandmarker}
                className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 font-bold transition-all active:scale-95 shadow-lg"
              >
                {faceLandmarker ? "측정 시작하기" : "시스템 로딩 중..."}
              </button>
            </div>

            {latestMeasurement && (
              <div className="mt-8 text-xs text-center text-gray-500">
                최근 측정: {latestMeasurement.recommended_size} 사이즈 ({new Date(latestMeasurement.created_at!).toLocaleDateString()})
              </div>
            )}
          </div>
        )}

        {/* 측정 중 오버레이 */}
        {step !== 'idle' && step !== 'complete' && (
          <div className="absolute inset-0 pointer-events-none">
            {/* 상단 상태 표시 */}
            <div className="absolute top-0 left-0 right-0 p-8 pt-12 bg-gradient-to-b from-black/80 to-transparent text-center z-10">
              <h2 className="text-xl font-bold text-white drop-shadow-md">{status}</h2>
              <p className="text-sm text-cyan-300 mt-1 font-medium">{subStatus}</p>
            </div>

            {/* 가이드라인 */}
            <svg className="absolute inset-0 w-full h-full opacity-40" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
              {(step === 'preparing' || step === 'scanning_front' || step === 'countdown') && (
                <ellipse cx="50" cy="50" rx="38" ry="42" fill="none" stroke="white" strokeWidth="0.8" strokeDasharray="4 4" />
              )}
              {step === 'turn_side' && (
                <>
                  <defs>
                    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                      <path d="M0,0 L0,6 L9,3 z" fill="cyan" />
                    </marker>
                  </defs>
                  <path d="M 50 20 Q 80 20 80 50" fill="none" stroke="cyan" strokeWidth="1" markerEnd="url(#arrow)" />
                </>
              )}
            </svg>

            {/* 중단 버튼 */}
            <div className="absolute top-4 right-4 z-20 pointer-events-auto">
              <button
                onClick={() => {
                  stopCamera();
                  handleRetry();
                }}
                className="px-3 py-1.5 rounded-lg bg-black/50 hover:bg-red-600/80 text-white text-xs font-medium transition-colors"
              >
                중단
              </button>
            </div>

            {/* 카운트다운 */}
            {step === 'countdown' && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
                <div className="text-6xl font-light text-white/90 font-mono drop-shadow-lg">
                  {countdown}
                </div>
                <p className="text-white/60 text-xs mt-2 font-light tracking-widest uppercase">자세 유지</p>
              </div>
            )}

            {/* 프로그레스바 */}
            {(step === 'scanning_front' || step === 'scanning_side') && (
              <div className="absolute bottom-10 left-10 right-10 z-20">
                <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-cyan-500 transition-all duration-200"
                    style={{ width: `${scanProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* 완료 화면 */}
        {step === 'complete' && finalResult && (
          <div className="absolute inset-0 bg-gray-900 flex flex-col p-6 z-30">
            <div className="flex-1 flex flex-col items-center pt-10">
              <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mb-6">
                <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                </svg>
              </div>

              <h2 className="text-2xl font-bold text-white mb-1">측정 완료</h2>
              <p className="text-gray-400 text-sm mb-8">AI 분석 결과가 준비되었습니다</p>

              <div className="w-full bg-gray-800 rounded-2xl p-6 border border-gray-700 space-y-4">
                <div className="flex justify-between items-center pb-4 border-b border-gray-700">
                  <span className="text-gray-400">추천 사이즈</span>
                  <span className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">
                    {recommendMaskSize(finalResult.front)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">코 너비</div>
                    <div className="font-semibold">{finalResult.front.noseWidth}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">얼굴 길이</div>
                    <div className="font-semibold">{finalResult.front.faceLength}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">코 높이</div>
                    <div className="font-semibold text-cyan-300">{finalResult.side.noseHeight}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">턱 각도</div>
                    <div className="font-semibold">{finalResult.front.chinAngle}°</div>
                  </div>
                  {!isFaceLengthInRange(finalResult.front.faceLength) && (
                    <div className="col-span-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                      거리가 멀어 값이 과대 측정되었을 수 있습니다. 재측정을 권장합니다.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleRetry}
                className="flex-1 py-4 rounded-xl bg-gray-700 hover:bg-gray-600 font-bold text-white transition-colors"
              >
                재측정
              </button>
              <button
                onClick={handleSave}
                className="flex-[2] py-4 rounded-xl bg-blue-600 hover:bg-blue-500 font-bold text-white shadow-lg transition-all active:scale-95"
              >
                결과 저장하기
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
