"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";
import { getOrCreateUserProfile, saveMeasurement, getLatestMeasurement, type MeasureLog } from "@/lib/supabase";
import { useMoabomTheme } from "@/lib/use-moabom-theme";
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import {
  performMeasurement,
  recommendMaskAdvanced,
  drawLandmarks,
  estimateYaw,
  performProfileMeasurement,
  initializeFaceLandmarker,
  PoseValidator,
  FaceMeasurementSession
} from "@/lib/face-measurement";

// 컴포넌트 임포트
import ProgressTabs from './components/ProgressTabs';
import SurveyScreen from './components/SurveyScreen';
import IdleScreen from './components/IdleScreen';
import ResultScreen from './components/ResultScreen';
import type { MeasurementStep, UserProfile, MeasurementResult, MaskRecommendation } from './types';

const COUNTDOWN_SECONDS = 3;
const SCAN_FRAMES = 90;
const YAW_THRESHOLD_FRONT = 10;
const YAW_THRESHOLD_PROFILE = 35;

export default function Home() {
  // 모아봄 테마 동기화
  useMoabomTheme({ debug: true });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 상태 관리
  const [step, setStep] = useState<MeasurementStep>('SURVEY');
  const stepRef = useRef<MeasurementStep>('SURVEY');

  // 설문 데이터
  const [userProfile, setUserProfile] = useState<UserProfile>({
    gender: 'male',
    ageGroup: '30s',
    tossing: 'medium',
    mouthBreathing: false,
    pressure: 'medium',
    preferredTypes: []
  });

  const [status, setStatus] = useState("준비 완료");
  const [subStatus, setSubStatus] = useState("");
  const [user, setUser] = useState<MoabomUser | null>(null);
  const [latestMeasurement, setLatestMeasurement] = useState<MeasureLog | null>(null);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);

  // 측정 데이터
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [scanProgress, setScanProgress] = useState(0);

  // 측정 세션 관리
  const measurementSessionRef = useRef<FaceMeasurementSession>(new FaceMeasurementSession(SCAN_FRAMES));

  const [finalResult, setFinalResult] = useState<MeasurementResult | null>(null);
  const [recommendation, setRecommendation] = useState<MaskRecommendation | null>(null);

  const animationFrameRef = useRef<number | null>(null);
  const stableFramesRef = useRef(0);
  const lastTimestampRef = useRef<number>(0);

  // State 동기화
  useEffect(() => { stepRef.current = step; }, [step]);

  // MediaPipe 초기화
  useEffect(() => {
    const initMediaPipe = async () => {
      try {
        const landmarker = await initializeFaceLandmarker();
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

  // 카운트다운 로직
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
          measurementSessionRef.current.reset();
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

      if (!ctx || video.readyState !== 4 || video.videoWidth === 0 || video.videoHeight === 0) {
        animationFrameRef.current = requestAnimationFrame(detectFace);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const now = performance.now();
      const videoTimeMs = video.currentTime * 1000;
      const timestampMs = Math.max(lastTimestampRef.current + 1, now, videoTimeMs);
      lastTimestampRef.current = timestampMs;

      const results = faceLandmarker.detectForVideo(video, timestampMs);

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];
        drawLandmarks(ctx, landmarks, canvas.width, canvas.height, true);

        const measurements = performMeasurement(results, canvas.width, canvas.height, userProfile.gender);
        const yaw = estimateYaw(landmarks);

        if (measurements) {
          const currentStep = stepRef.current;
          processStep(currentStep, measurements, yaw, landmarks);
        }
      } else {
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
  }, [faceLandmarker, userProfile.gender]);

  // 단계별 처리 로직
  const processStep = (currentStep: MeasurementStep, measurements: any, yaw: number, landmarks: any[]) => {
    const session = measurementSessionRef.current;

    switch (currentStep) {
      case 'GUIDE_CHECK':
        if (PoseValidator.isFrontFacing(yaw, YAW_THRESHOLD_FRONT)) {
          stableFramesRef.current++;
          setSubStatus(`정면 확인 중... ${Math.min(stableFramesRef.current, 20)}/20`);

          if (stableFramesRef.current > 20) {
            setStatus("측정을 시작합니다");
            setSubStatus("");
            setStep('COUNTDOWN');
            stepRef.current = 'COUNTDOWN';
          }
        } else {
          stableFramesRef.current = 0;
          setSubStatus("정면을 봐주세요");
        }
        break;

      case 'SCANNING_FRONT': {
        session.addFrontMeasurement(measurements);
        const progress = session.getFrontProgress();
        
        if (session.getFrontProgress() % 10 === 1 || session.isFrontComplete()) {
          setScanProgress(progress);
          setStatus("정면 스캔 중...");
          setSubStatus(`${progress}% 완료`);
        }

        if (session.isFrontComplete()) {
          session.finalizeFrontMeasurement();
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
        if (PoseValidator.isProfileFacing(yaw, YAW_THRESHOLD_PROFILE)) {
          stableFramesRef.current++;

          if (stableFramesRef.current > 10) {
            setStep('SCANNING_PROFILE');
            stepRef.current = 'SCANNING_PROFILE';
          }
        } else {
          stableFramesRef.current = 0;
        }
        break;

      case 'SCANNING_PROFILE': {
        const fixedScale = session.getFixedScaleFactor();
        const canvas = canvasRef.current;
        if (!canvas) break;
        
        const profileData = performProfileMeasurement(landmarks, fixedScale, canvas.width, canvas.height);
        session.addProfileMeasurement(profileData);
        
        const progress = session.getProfileProgress();
        if (progress % 10 === 1 || session.isProfileComplete()) {
          setScanProgress(progress);
          setStatus("측면 스캔 중...");
          setSubStatus(`${progress}% 완료`);
        }

        if (session.isProfileComplete()) {
          finishMeasurement();
        }
        break;
      }
    }
  };

  // 측정 완료
  const finishMeasurement = () => {
    const results = measurementSessionRef.current.getFinalResults();
    
    if (!results) {
      setStatus("에러: 측정 데이터 부족");
      return;
    }

    setFinalResult(results);
    
    const advancedRecommendation = recommendMaskAdvanced(results.front, results.profile, userProfile);
    setRecommendation(advancedRecommendation);
    
    setStep('COMPLETE');
    setStatus("측정 완료");
    setSubStatus("결과를 확인하고 저장하세요");

    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
    }
  };

  // 카메라 시작
  const startCamera = async () => {
    if (!user) {
      setStatus("에러: 로그인이 필요합니다");
      return;
    }
    if (!faceLandmarker) {
      setStatus("에러: AI 모델 로딩 중...");
      return;
    }

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
        
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("Video load failed"));
          setTimeout(() => reject(new Error("Video load timeout")), 5000);
        });

        await video.play();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (video.readyState >= 2 && video.videoWidth > 0) {
          setCameraStarting(false);
          setStep('GUIDE_CHECK');
          stepRef.current = 'GUIDE_CHECK';
          setStatus("카메라를 정면으로 봐주세요");
          lastTimestampRef.current = 0;
          
          requestAnimationFrame(detectFace);
        } else {
          throw new Error("Video not ready");
        }
      }
    } catch (err: any) {
      console.error("카메라 에러:", err);
      setCameraStarting(false);
      
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
      
      setStatus(err.name === 'NotAllowedError' ? "카메라 권한이 필요합니다" : "카메라 연결 실패");
    }
  };

  // 저장
  const handleSave = async () => {
    if (!user || !finalResult) return;

    setStatus("저장 중...");

    const saveData = {
      user_id: user.mb_id,
      user_name: user.mb_nick,
      nose_width: finalResult.front.noseWidth,
      face_length: finalResult.front.faceLength,
      face_width: finalResult.front.faceWidth,
      philtrum_length: finalResult.front.philtrumLength,
      mouth_width: finalResult.front.mouthWidth,
      bridge_width: finalResult.front.bridgeWidth,
      nose_height: finalResult.profile.noseHeight,
      jaw_projection: finalResult.profile.jawProjection,
      recommended_size: recommendation?.size || 'M',
      measurement_data: {
        timestamp: new Date().toISOString(),
        profile: finalResult.profile,
        front_raw: finalResult.front
      }
    };

    const res = await saveMeasurement(saveData);
    if (res.success) {
      setLatestMeasurement(res.data!);
      
      window.parent.postMessage({ 
        type: 'SHOW_TOAST', 
        message: '측정 결과가 저장되었습니다!',
        variant: 'success'
      }, '*');
      
      window.parent.postMessage({ 
        type: 'MEASUREMENT_COMPLETE', 
        data: res.data 
      }, '*');
    } else {
      window.parent.postMessage({ 
        type: 'SHOW_TOAST', 
        message: '저장에 실패했습니다. 다시 시도해주세요.',
        variant: 'error'
      }, '*');
    }
  };

  // 재시도
  const handleRetry = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    setStep('SURVEY');
    stepRef.current = 'SURVEY';
    setFinalResult(null);
    setRecommendation(null);
    setScanProgress(0);
    measurementSessionRef.current.reset();
    stableFramesRef.current = 0;
    lastTimestampRef.current = 0;
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center font-sans text-moa-text">
      {/* 메인 뷰포트 */}
      <div className="relative w-full h-screen md:h-auto md:max-h-screen md:aspect-video flex flex-col items-center justify-center overflow-hidden">
        
        {/* 상단 프로그레스 탭 */}
        <ProgressTabs currentStep={step} />

        {/* 카메라 비디오 */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-500 ${step === 'IDLE' || step === 'SURVEY' ? 'opacity-0' : 'opacity-100'}`}
          style={{ transform: 'scaleX(-1)' }}
        />
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full pointer-events-none ${step === 'COMPLETE' ? 'hidden' : ''}`}
          style={{ transform: 'scaleX(-1)' }}
        />

        {/* 화면별 컴포넌트 */}
        {step === 'SURVEY' && (
          <SurveyScreen
            userProfile={userProfile}
            onProfileChange={setUserProfile}
            onNext={() => setStep('IDLE')}
          />
        )}

        {step === 'IDLE' && (
          <IdleScreen
            hasUser={!!user}
            hasFaceLandmarker={!!faceLandmarker}
            cameraStarting={cameraStarting}
            onStartCamera={startCamera}
          />
        )}

        {/* 가이드 오버레이 */}
        {step !== 'IDLE' && step !== 'SURVEY' && step !== 'COMPLETE' && (
          <div className="absolute inset-0 pointer-events-none pt-20">
            {/* 상단 메시지 바 */}
            <div className="absolute top-20 left-0 right-0 p-8 pt-8 text-center z-10">
              <h2 className="text-xl font-bold text-moa-text drop-shadow-md">{status}</h2>
              <p className="text-sm text-moa-main mt-1 animate-pulse font-medium">{subStatus}</p>
            </div>

            {/* 측면 회전 가이드 */}
            {step === 'GUIDE_TURN_SIDE' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="flex items-center gap-8">
                  <i 
                    className="ri-arrow-left-s-line text-6xl text-moa-main"
                    style={{ 
                      animation: 'slideLeft 2s ease-in-out infinite',
                      filter: 'drop-shadow(0 0 8px rgba(139, 92, 246, 0.6))'
                    }}
                  ></i>
                  
                  <div className="text-moa-main font-bold text-xl opacity-80">또는</div>
                  
                  <i 
                    className="ri-arrow-right-s-line text-6xl text-moa-main"
                    style={{ 
                      animation: 'slideRight 2s ease-in-out infinite',
                      filter: 'drop-shadow(0 0 8px rgba(139, 92, 246, 0.6))'
                    }}
                  ></i>
                </div>
              </div>
            )}

            {/* 중단 버튼 */}
            {(step === 'GUIDE_CHECK' || step === 'COUNTDOWN' || step === 'SCANNING_FRONT' || step === 'GUIDE_TURN_SIDE' || step === 'SCANNING_PROFILE') && (
              <div className="absolute top-24 right-6 z-20 pointer-events-auto">
                <button
                  onClick={handleRetry}
                  className="px-3 py-1.5 rounded-lg glass-panel hover:bg-red-600/80 text-white text-xs font-medium transition-colors flex items-center gap-1"
                >
                  <i className="ri-close-line"></i>
                  중단
                </button>
              </div>
            )}
          </div>
        )}

        {/* 카운트다운 */}
        {step === 'COUNTDOWN' && (
          <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
            <div className="flex flex-col items-center">
              <div className="relative">
                <div className="absolute inset-0 opacity-20 blur-xl rounded-full"></div>
                <div className="relative text-6xl font-light text-white/90 font-mono tracking-widest drop-shadow-lg">
                  {countdown}
                </div>
              </div>
              <p className="text-white/60 text-xs mt-2 font-light tracking-widest uppercase">자세 유지</p>
            </div>
          </div>
        )}

        {/* 프로그레스 바 */}
        {(step === 'SCANNING_FRONT' || step === 'SCANNING_PROFILE') && (
          <div className="absolute bottom-8 left-6 right-6 z-20 pointer-events-none">
            <div className="h-2 bg-moa-bg-secondary rounded-full overflow-hidden">
              <div 
                className="h-full bg-moa-main transition-all duration-300"
                style={{ width: `${scanProgress}%` }}
              ></div>
            </div>
          </div>
        )}

        {/* 결과 화면 */}
        {step === 'COMPLETE' && finalResult && recommendation && (
          <ResultScreen
            result={finalResult}
            recommendation={recommendation}
            onSave={handleSave}
            onRetry={handleRetry}
          />
        )}
      </div>
    </div>
  );
}
