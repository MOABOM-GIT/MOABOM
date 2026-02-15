"use client";

import { useRef, useEffect, useState, useCallback } from "react";
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
  LANDMARKS
} from "@/lib/face-measurement";

// 측정 단계 정의
type MeasurementStep =
  | 'IDLE'
  | 'INIT'
  | 'GUIDE_CHECK'     // 정면 가이드 맞추기
  | 'COUNTDOWN'       // 3, 2, 1
  | 'SCANNING_FRONT'  // 정면 스캔 위
  | 'GUIDE_TURN_SIDE' // 측면 돌리기 안내
  | 'SCANNING_PROFILE'// 측면 스캔 중
  | 'COMPLETE';       // 완료

const COUNTDOWN_SECONDS = 3;
const SCAN_FRAMES = 90; // 약 3초 동안 데이터 수집 (30fps 기준) - 천천히 측정
const YAW_THRESHOLD_FRONT = 10; // 정면 허용 각도
const YAW_THRESHOLD_PROFILE = 35; // 측면 인식 최소 각도

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 상태 관리
  const [step, setStep] = useState<MeasurementStep>('IDLE');
  const stepRef = useRef<MeasurementStep>('IDLE'); // Loop용 Ref

  const [status, setStatus] = useState("준비 완료");
  const [subStatus, setSubStatus] = useState("");
  const [user, setUser] = useState<MoabomUser | null>(null);
  const [latestMeasurement, setLatestMeasurement] = useState<MeasureLog | null>(null);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);

  // 측정 데이터
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [scanProgress, setScanProgress] = useState(0); // 0–100, 프로그레스바용

  // 데이터 버퍼 (Ref로 관리하여 Loop 내 접근 보장)
  const frontBufferRef = useRef<FaceMeasurements[]>([]);
  const profileBufferRef = useRef<ProfileMeasurements[]>([]);

  const [finalResult, setFinalResult] = useState<{ front: FaceMeasurements, profile: ProfileMeasurements } | null>(null);
  const [fixedScaleFactor, setFixedScaleFactor] = useState<number>(0);
  const fixedScaleFactorRef = useRef<number>(0);

  const animationFrameRef = useRef<number | null>(null);
  const stableFramesRef = useRef(0); // 자세 안정화 프레임 카운터
  const lastTimestampRef = useRef<number>(0); // MediaPipe VIDEO 모드용 타임스탬프

  // State 동기화
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { fixedScaleFactorRef.current = fixedScaleFactor; }, [fixedScaleFactor]);

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

  // 단계별 로직 처리 (useEffect for Countdown)
  useEffect(() => {
    if (step === 'COUNTDOWN') {
      let count = COUNTDOWN_SECONDS;
      setCountdown(count);
      const timer = setInterval(() => {
        count--;
        setCountdown(count);
        if (count === 0) {
          clearInterval(timer);
          setScanProgress(0);
          setStep('SCANNING_FRONT');
          frontBufferRef.current = [];
        }
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [step]);

  // 실시간 감지 루프
  const detectFace = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !faceLandmarker) return;

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');

      // 비디오가 완전히 준비될 때까지 대기 (readyState 4 = HAVE_ENOUGH_DATA)
      if (!ctx || video.readyState !== 4 || video.videoWidth === 0 || video.videoHeight === 0) {
        animationFrameRef.current = requestAnimationFrame(detectFace);
        return;
      }

      // 캔버스 크기 맞춤
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // MediaPipe VIDEO 모드: 타임스탬프는 반드시 단조 증가해야 함
      const now = performance.now();
      const videoTimeMs = video.currentTime * 1000;
      const timestampMs = Math.max(lastTimestampRef.current + 1, now, videoTimeMs);
      lastTimestampRef.current = timestampMs;

      // 얼굴 감지
      const results = faceLandmarker.detectForVideo(video, timestampMs);

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];

        // 기본 드로잉 (얼굴 감지됨)
        drawLandmarks(ctx, landmarks, canvas.width, canvas.height, true);

        // 측정값 계산
        const measurements = performMeasurement(results);
        const yaw = estimateYaw(landmarks);

        if (measurements) {
          const currentStep = stepRef.current;
          processStep(currentStep, measurements, yaw, landmarks);
        }
      } else {
        // 얼굴 없음 - 가이드만 표시
        drawLandmarks(ctx, [], canvas.width, canvas.height, false);
        
        const currentStep = stepRef.current;
        if (currentStep === 'GUIDE_CHECK' || currentStep === 'GUIDE_TURN_SIDE') {
          setSubStatus("얼굴을 찾을 수 없습니다");
          stableFramesRef.current = 0;
        } else if (currentStep === 'SCANNING_FRONT' || currentStep === 'SCANNING_PROFILE') {
          setSubStatus("얼굴을 다시 찾아주세요");
          stableFramesRef.current = 0;
        }
      }

      // 루프 지속 조건 확인 (Ref 사용)
      const currentStep = stepRef.current;
      if (currentStep !== 'COMPLETE' && currentStep !== 'IDLE') {
        animationFrameRef.current = requestAnimationFrame(detectFace);
      }
    } catch (e) {
      console.error("Detection Loop Error:", e);
      const currentStep = stepRef.current;
      if (currentStep !== 'COMPLETE' && currentStep !== 'IDLE') {
        setTimeout(() => {
          if (stepRef.current !== 'COMPLETE' && stepRef.current !== 'IDLE') {
            animationFrameRef.current = requestAnimationFrame(detectFace);
          }
        }, 100);
      }
    }
  }, [faceLandmarker]);

  // 단계별 처리 로직
  const processStep = (currentStep: MeasurementStep, measurements: FaceMeasurements, yaw: number, landmarks: any[]) => {
    switch (currentStep) {
      case 'GUIDE_CHECK':
        // 정면 응시 확인 (Yaw가 0에 가까워야 함)
        if (Math.abs(yaw) < YAW_THRESHOLD_FRONT) {
          stableFramesRef.current++;
          setSubStatus(`정면 확인 중... ${Math.min(stableFramesRef.current, 20)}/20`);

          if (stableFramesRef.current > 20) { // 약 0.6초 유지
            setStatus("측정을 시작합니다");
            setSubStatus("");

            // State Update
            setStep('COUNTDOWN');
            // Ref Update (즉시 반영을 위해)
            stepRef.current = 'COUNTDOWN';
          }
        } else {
          stableFramesRef.current = 0;
          setSubStatus("정면을 봐주세요");
        }
        break;

      case 'SCANNING_FRONT': {
        // 정면 데이터 수집
        frontBufferRef.current.push(measurements);
        const len = frontBufferRef.current.length;
        const pct = Math.round((len / SCAN_FRAMES) * 100);
        // 10프레임마다 한 번만 상태 업데이트 (리렌더 스로틀)
        if (len % 10 === 1 || len >= SCAN_FRAMES) {
          setScanProgress(pct);
          setStatus("정면 스캔 중...");
          setSubStatus(`${pct}% 완료`);
        }

        if (len >= SCAN_FRAMES) {
          // 정면 스캔 완료 시 스케일 팩터 고정
          const avgScale = frontBufferRef.current.reduce((acc, cur) => acc + cur.scaleFactor, 0) / frontBufferRef.current.length;
          setFixedScaleFactor(avgScale);
          fixedScaleFactorRef.current = avgScale; // Sync Ref

          setStep('GUIDE_TURN_SIDE');
          stepRef.current = 'GUIDE_TURN_SIDE';

          setStatus("측면 측정");
          setSubStatus("고개를 천천히 옆으로 돌려주세요");
          stableFramesRef.current = 0;
          setScanProgress(0);
        }
        break;
      }

      case 'GUIDE_TURN_SIDE':
        // 측면 회전 확인 (Yaw가 일정 이상이어야 함)
        if (Math.abs(yaw) > YAW_THRESHOLD_PROFILE) {
          stableFramesRef.current++;

          if (stableFramesRef.current > 10) {
            setStep('SCANNING_PROFILE');
            stepRef.current = 'SCANNING_PROFILE';
            profileBufferRef.current = []; // 초기화
          }
        } else {
          stableFramesRef.current = 0; // 다시 돌아오면 리셋
        }
        break;

      case 'SCANNING_PROFILE': {
        // 측면 데이터 수집 - 고정된 스케일 팩터 사용 (Ref)
        const profileData = performProfileMeasurement(landmarks, fixedScaleFactorRef.current);
        profileBufferRef.current.push(profileData);
        const plen = profileBufferRef.current.length;
        const ppct = Math.round((plen / SCAN_FRAMES) * 100);
        if (plen % 10 === 1 || plen >= SCAN_FRAMES) {
          setScanProgress(ppct);
          setStatus("측면 스캔 중...");
          setSubStatus(`${ppct}% 완료`);
        }

        if (plen >= SCAN_FRAMES) {
          finishMeasurement();
        }
        break;
      }
    }
  };

  // 측정 완료 및 결과 처리
  const finishMeasurement = () => {
    // 평균값 계산
    const avgFront = calculateAverageFront(frontBufferRef.current);
    const avgProfile = calculateAverageProfile(profileBufferRef.current);

    setFinalResult({
      front: avgFront,
      profile: avgProfile
    });

    setStep('COMPLETE');
    setStatus("측정 완료");
    setSubStatus("결과를 확인하고 저장하세요");

    // 카메라 정지
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
    }
  };

  const calculateAverageFront = (buffer: FaceMeasurements[]): FaceMeasurements => {
    if (buffer.length === 0) {
      return {
        noseWidth: 0,
        faceLength: 0,
        chinAngle: 0,
        ipdPixels: 0,
        scaleFactor: 0,
        confidence: 0
      };
    }

    // 간단 평균
    const sum = buffer.reduce((acc, cur) => ({
      noseWidth: acc.noseWidth + cur.noseWidth,
      faceLength: acc.faceLength + cur.faceLength,
      chinAngle: acc.chinAngle + cur.chinAngle,
      ipdPixels: acc.ipdPixels + cur.ipdPixels,
      scaleFactor: acc.scaleFactor + cur.scaleFactor,
      confidence: acc.confidence
    }), { noseWidth: 0, faceLength: 0, chinAngle: 0, ipdPixels: 0, scaleFactor: 0, confidence: 0 });

    const count = buffer.length;
    return {
      noseWidth: Math.round(sum.noseWidth / count * 10) / 10,
      faceLength: Math.round(sum.faceLength / count * 10) / 10,
      chinAngle: Math.round(sum.chinAngle / count * 10) / 10,
      ipdPixels: sum.ipdPixels / count,
      scaleFactor: sum.scaleFactor / count,
      confidence: 0.95
    };
  };

  const calculateAverageProfile = (buffer: ProfileMeasurements[]): ProfileMeasurements => {
    if (buffer.length === 0) return { noseHeight: 0, faceDepth: 0 };

    const sum = buffer.reduce((acc, cur) => ({
      noseHeight: acc.noseHeight + cur.noseHeight,
      faceDepth: acc.faceDepth + cur.faceDepth
    }), { noseHeight: 0, faceDepth: 0 });

    const count = buffer.length;
    return {
      noseHeight: Math.round(sum.noseHeight / count * 10) / 10,
      faceDepth: Math.round(sum.faceDepth / count * 10) / 10
    };
  };

  const stopCamera = useCallback(() => {
    // 애니메이션 프레임 취소
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    // 카메라 스트림 정지
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    
    // 상태 초기화
    setStep('IDLE');
    setScanProgress(0);
    frontBufferRef.current = [];
    profileBufferRef.current = [];
    stableFramesRef.current = 0;
    lastTimestampRef.current = 0;
  }, []);

  const startCamera = async () => {
    if (!user) {
      setStatus("에러: 로그인이 필요합니다");
      return;
    }
    if (!faceLandmarker) {
      setStatus("에러: AI 모델 로딩 중...");
      return;
    }

    // 이전 실행이 남아있을 수 있으므로 먼저 정리
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    setCameraStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });

      if (videoRef.current) {
        const video = videoRef.current;
        video.srcObject = stream;
        
        // 비디오 메타데이터 로드 대기
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("Video load failed"));
          setTimeout(() => reject(new Error("Video load timeout")), 5000);
        });

        // 비디오 재생 시작
        await video.play();
        
        // 비디오가 실제로 재생 중인지 확인
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (video.readyState >= 2 && video.videoWidth > 0) {
          setCameraStarting(false);
          setStep('GUIDE_CHECK');
          stepRef.current = 'GUIDE_CHECK';
          setStatus("카메라를 정면으로 봐주세요");
          lastTimestampRef.current = 0;
          
          // 감지 루프 시작
          requestAnimationFrame(detectFace);
        } else {
          throw new Error("Video not ready");
        }
      }
    } catch (err: any) {
      console.error("카메라 에러:", err);
      setCameraStarting(false);
      
      // 실패 시 스트림 정리
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
      
      setStatus(err.name === 'NotAllowedError' ? "카메라 권한이 필요합니다" : "카메라 연결 실패");
    }
  };

  const handleSave = async () => {
    if (!user || !finalResult) return;

    setStatus("저장 중...");

    const recommendedSize = recommendMaskSize(finalResult.front);
    const saveData = {
      user_id: user.mb_id,
      user_name: user.mb_nick,
      nose_width: finalResult.front.noseWidth,
      face_length: finalResult.front.faceLength,
      chin_angle: finalResult.front.chinAngle,
      recommended_size: recommendedSize,
      measurement_data: {
        timestamp: new Date().toISOString(),
        profile: finalResult.profile,
        front_raw: finalResult.front
      }
    };

    const res = await saveMeasurement(saveData);
    if (res.success) {
      setLatestMeasurement(res.data!);
      alert("저장되었습니다!");
      window.parent.postMessage({ type: 'MEASUREMENT_COMPLETE', data: res.data }, '*');
    } else {
      alert("저장 실패");
    }
  };

  const handleRetry = () => {
    // 완전 초기화
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    setStep('IDLE');
    stepRef.current = 'IDLE';
    setFinalResult(null);
    setScanProgress(0);
    frontBufferRef.current = [];
    profileBufferRef.current = [];
    stableFramesRef.current = 0;
    lastTimestampRef.current = 0;
    
    // 약간의 지연 후 재시작
    setTimeout(() => {
      startCamera();
    }, 100);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black font-sans text-white overflow-hidden">
      {/* 메인 뷰포트 */}
      <div className="relative w-full h-screen max-w-md mx-auto bg-gray-900 shadow-2xl overflow-hidden">
        {/* 카메라 비디오 */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${step === 'IDLE' ? 'opacity-0' : 'opacity-100'}`}
          style={{ transform: 'scaleX(-1)' }}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: 'scaleX(-1)' }}
        />

        {/* UI 레이어: 상태별 오버레이 */}

        {/* 1. IDLE 상태 */}
        {step === 'IDLE' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-gray-800 to-black">
            <h1 className="text-3xl font-bold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
              SmartCare AI
            </h1>
            <p className="text-gray-400 mb-8 text-center max-w-xs">
              정확한 양압기 마스크 추천을 위해<br />3D 안면 분석을 시작합니다.
            </p>
            <div className="space-y-4 w-full max-w-xs">
              <div className="bg-gray-800/50 p-4 rounded-xl border border-gray-700">
                <h3 className="text-sm font-semibold text-gray-300 mb-2">측정 가이드</h3>
                <ul className="text-xs text-gray-400 space-y-2 list-disc pl-4">
                  <li>밝은 곳에서 촬영해주세요</li>
                  <li>모자나 안경을 벗어주세요</li>
                  <li>정면과 측면 측정이 진행됩니다</li>
                </ul>
              </div>

              <button
                onClick={startCamera}
                disabled={!user || !faceLandmarker || cameraStarting}
                className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 font-bold transition-all active:scale-95 shadow-lg shadow-blue-900/20"
              >
                {cameraStarting ? "카메라 연결 중..." : faceLandmarker ? "측정 시작하기" : "시스템 로딩 중..."}
              </button>
            </div>

            {latestMeasurement && (
              <div className="mt-8 text-xs text-center text-gray-500">
                최근 측정: {latestMeasurement.recommended_size} 사이즈 ({new Date(latestMeasurement.created_at!).toLocaleDateString()})
              </div>
            )}
          </div>
        )}

        {/* 2. 가이드 오버레이 (공통) */}
        {step !== 'IDLE' && step !== 'COMPLETE' && (
          <div className="absolute inset-0 pointer-events-none">
            {/* 상단 메시지 바 */}
            <div className="absolute top-0 left-0 right-0 p-8 pt-12 bg-gradient-to-b from-black/80 to-transparent text-center z-10">
              <h2 className="text-xl font-bold text-white drop-shadow-md">{status}</h2>
              <p className="text-sm text-cyan-300 mt-1 animate-pulse font-medium">{subStatus}</p>
            </div>

            {/* 가이드라인 SVG */}
            <svg className="absolute inset-0 w-full h-full opacity-40" viewBox="0 0 100 100" preserveAspectRatio="none">
              <defs>
                <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L9,3 z" fill="cyan" />
                </marker>
              </defs>
              {/* 정면 가이드 - 계란형 */}
              {(step === 'GUIDE_CHECK' || step === 'SCANNING_FRONT' || step === 'COUNTDOWN') && (
                <ellipse cx="50" cy="50" rx="32" ry="46" fill="none" stroke="white" strokeWidth="0.8" strokeDasharray="4 4" />
              )}
              {/* 측면 가이드 - 화살표 (고개를 옆으로 돌리세요) */}
              {(step === 'GUIDE_TURN_SIDE') && (
                <path d="M 50 20 Q 80 20 80 50" fill="none" stroke="cyan" strokeWidth="1" markerEnd="url(#arrow)" />
              )}
            </svg>

            {/* 측정 중단 버튼 */}
            <div className="absolute top-4 right-4 z-20 pointer-events-auto">
              <button
                type="button"
                onClick={stopCamera}
                className="px-3 py-1.5 rounded-lg bg-black/50 hover:bg-red-600/80 text-white text-xs font-medium transition-colors"
              >
                중단
              </button>
            </div>

            {/* 카운트다운 (작게 표시) */}
            {step === 'COUNTDOWN' && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center">
                <div className="relative">
                  <div className="absolute inset-0 bg-black/40 blur-xl rounded-full"></div>
                  <div className="relative text-6xl font-light text-white/90 font-mono tracking-widest drop-shadow-lg">
                    {countdown}
                  </div>
                </div>
                <p className="text-white/60 text-xs mt-2 font-light tracking-widest uppercase">자세 유지</p>
              </div>
            )}
          </div>
        )}

        {/* 4. 스캔 프로그레스 */}
        {(step === 'SCANNING_FRONT' || step === 'SCANNING_PROFILE') && (
          <div className="absolute bottom-10 left-10 right-10 z-20">
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500 transition-all duration-200"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* 5. 완료 결과 화면 */}
        {step === 'COMPLETE' && finalResult && (
          <div className="absolute inset-0 bg-gray-900 flex flex-col p-6 z-30 animate-in fade-in slide-in-from-bottom-10 duration-500">
            <div className="flex-1 flex flex-col items-center pt-10">
              <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mb-6">
                <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
              </div>

              <h2 className="text-2xl font-bold text-white mb-1">측정 완료</h2>
              <p className="text-gray-400 text-sm mb-8">AI 분석 결과가 준비되었습니다.</p>

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
                    <div className="text-gray-500 text-xs mb-1">코 높이 (측면)</div>
                    <div className="font-semibold text-cyan-300">{finalResult.profile.noseHeight}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">턱 각도</div>
                    <div className="font-semibold">{finalResult.front.chinAngle}°</div>
                  </div>
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