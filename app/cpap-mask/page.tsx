"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { getMoabomUser, type MoabomUser } from "@/lib/moabom-auth";
import { getOrCreateUserProfile, saveMeasurement, getLatestMeasurement, type MeasureLog } from "@/lib/supabase";
import { useMoabomTheme } from "@/lib/use-moabom-theme";
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import {
  performMeasurement,
  recommendMaskSize,
  recommendMaskAdvanced,
  drawLandmarks,
  type FaceMeasurements,
  type UserProfile,
  type MaskRecommendation,
  estimateYaw,
  performProfileMeasurement,
  type ProfileMeasurements,
  initializeFaceLandmarker,
  PoseValidator,
  FaceMeasurementSession
} from "@/lib/face-measurement";

// 측정 단계 정의
type MeasurementStep =
  | 'SURVEY'          // 설문 조사
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
  // 모아봄 테마 동기화
  const { theme, primaryColor, isDark } = useMoabomTheme({ debug: true });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 상태 관리
  const [step, setStep] = useState<MeasurementStep>('SURVEY');
  const stepRef = useRef<MeasurementStep>('SURVEY'); // Loop용 Ref

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
  const [scanProgress, setScanProgress] = useState(0); // 0–100, 프로그레스바용

  // 측정 세션 관리
  const measurementSessionRef = useRef<FaceMeasurementSession>(new FaceMeasurementSession(SCAN_FRAMES));

  const [finalResult, setFinalResult] = useState<{ front: FaceMeasurements, profile: ProfileMeasurements } | null>(null);
  const [recommendation, setRecommendation] = useState<MaskRecommendation | null>(null);

  const animationFrameRef = useRef<number | null>(null);
  const stableFramesRef = useRef(0); // 자세 안정화 프레임 카운터
  const lastTimestampRef = useRef<number>(0); // MediaPipe VIDEO 모드용 타임스탬프

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

        // 측정값 계산 - 캔버스 크기 + 성별 전달
        const measurements = performMeasurement(results, canvas.width, canvas.height, userProfile.gender);
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
    const session = measurementSessionRef.current;

    switch (currentStep) {
      case 'GUIDE_CHECK':
        // 정면 응시 확인
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
        // 정면 데이터 수집
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
        // 측면 회전 확인
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
        // 측면 데이터 수집
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

  // 측정 완료 및 결과 처리
  const finishMeasurement = () => {
    const results = measurementSessionRef.current.getFinalResults();
    
    if (!results) {
      setStatus("에러: 측정 데이터 부족");
      return;
    }

    setFinalResult(results);
    
    // 종합 추천 생성
    const advancedRecommendation = recommendMaskAdvanced(results.front, results.profile, userProfile);
    setRecommendation(advancedRecommendation);
    
    setStep('COMPLETE');
    setStatus("측정 완료");
    setSubStatus("결과를 확인하고 저장하세요");

    // 카메라 정지
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
    }
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
    measurementSessionRef.current.reset();
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
      face_width: finalResult.front.faceWidth,
      philtrum_length: finalResult.front.philtrumLength,
      mouth_width: finalResult.front.mouthWidth,
      bridge_width: finalResult.front.bridgeWidth,
      nose_height: finalResult.profile.noseHeight,
      jaw_projection: finalResult.profile.jawProjection,
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
      
      // 부모 창(모아봄)에 토스트 메시지 전송
      window.parent.postMessage({ 
        type: 'SHOW_TOAST', 
        message: '측정 결과가 저장되었습니다!',
        variant: 'success' // 또는 'info', 'warning', 'error'
      }, '*');
      
      // 측정 완료 데이터도 함께 전송
      window.parent.postMessage({ 
        type: 'MEASUREMENT_COMPLETE', 
        data: res.data 
      }, '*');
    } else {
      // 에러 토스트
      window.parent.postMessage({ 
        type: 'SHOW_TOAST', 
        message: '저장에 실패했습니다. 다시 시도해주세요.',
        variant: 'error'
      }, '*');
    }
  };

  const handleRetry = () => {
    // 완전 초기화
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    // 설문으로 돌아가기
    setStep('SURVEY');
    stepRef.current = 'SURVEY';
    setFinalResult(null);
    setRecommendation(null);
    setScanProgress(0);
    measurementSessionRef.current.reset();
    stableFramesRef.current = 0;
    lastTimestampRef.current = 0;
  };

  // 현재 단계 계산 (프로그레스 바용)
  const getCurrentPhase = (): 1 | 2 | 3 => {
    if (step === 'SURVEY') return 1;
    if (step === 'COMPLETE') return 3;
    return 2; // IDLE, GUIDE_CHECK, COUNTDOWN, SCANNING_FRONT, GUIDE_TURN_SIDE, SCANNING_PROFILE
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center font-sans text-moa-text">
      {/* 메인 뷰포트 - 모바일: 전체화면, PC: 비율 유지 */}
      <div className="relative w-full h-screen md:h-auto md:max-h-screen md:aspect-video flex flex-col items-center justify-center overflow-hidden">
        
        {/* 상단 프로그레스 탭 */}
        <div className="absolute top-0 left-0 right-0 z-50 glass-panel border-b border-moa-bg-secondary">
          <div className="flex items-center justify-center px-4 py-3">
            {[
              { phase: 1, label: '설문', icon: 'ri-survey-line' },
              { phase: 2, label: '안면분석', icon: 'ri-scan-line' },
              { phase: 3, label: '결과', icon: 'ri-check-line' }
            ].map(({ phase, label, icon }, idx) => {
              const currentPhase = getCurrentPhase();
              const isActive = currentPhase === phase;
              const isCompleted = currentPhase > phase;
              
              return (
                <div key={phase} className="flex items-center">
                  <div className="flex flex-col items-center">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold transition-all ${
                      isCompleted 
                        ? 'bg-moa-main text-white' 
                        : isActive 
                          ? 'bg-moa-main text-white ring-4 ring-moa-main-light' 
                          : 'bg-moa-bg-secondary text-moa-text-tertiary'
                    }`}>
                      <i className={isCompleted ? 'ri-check-line' : icon}></i>
                    </div>
                    <span className={`text-xs mt-1 font-medium ${
                      isActive ? 'text-moa-main' : isCompleted ? 'text-moa-main' : 'text-moa-text-tertiary'
                    }`}>
                      {label}
                    </span>
                  </div>
                  
                  {idx < 2 && (
                    <div className={`w-12 h-0.5 mx-2 mb-5 transition-all ${
                      isCompleted ? 'bg-moa-main' : 'bg-moa-bg-secondary'
                    }`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

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
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: 'scaleX(-1)' }}
        />

        {/* UI 레이어: 상태별 오버레이 */}

        {/* 0. 설문 화면 */}
        {step === 'SURVEY' && (
          <div className="absolute inset-0 flex flex-col">
            {/* 스크롤 가능한 컨텐츠 영역 */}
            <div className="flex-1 overflow-y-auto pt-24 pb-6 px-6">
              <div className="flex flex-col items-center">
                <h1 className="text-2xl font-bold mb-2 text-moa-main">
                  SmartCare AI
                </h1>
                <p className="text-moa-text-secondary mb-6 text-center text-sm">
                  정확한 마스크 추천을 위해 몇 가지 질문에 답해주세요
                </p>

            <div className="w-full max-w-md space-y-6">
              {/* 성별 */}
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-3 flex items-center gap-2">
                  <i className="ri-user-line"></i> 성별
                </h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => setUserProfile({...userProfile, gender: 'male'})}
                    className={`flex-1 py-3 rounded-lg font-medium transition-all ${
                      userProfile.gender === 'male' 
                        ? 'bg-moa-main text-white' 
                        : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                    }`}
                  >
                    남성
                  </button>
                  <button
                    onClick={() => setUserProfile({...userProfile, gender: 'female'})}
                    className={`flex-1 py-3 rounded-lg font-medium transition-all ${
                      userProfile.gender === 'female' 
                        ? 'bg-moa-main text-white' 
                        : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                    }`}
                  >
                    여성
                  </button>
                </div>
              </div>

              {/* 연령대 */}
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-3 flex items-center gap-2">
                  <i className="ri-calendar-line"></i> 연령대
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {(['20s', '30s', '40s', '50s', '60+'] as const).map((age) => (
                    <button
                      key={age}
                      onClick={() => setUserProfile({...userProfile, ageGroup: age})}
                      className={`py-2 rounded-lg text-sm font-medium transition-all ${
                        userProfile.ageGroup === age 
                          ? 'bg-moa-main text-white' 
                          : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                      }`}
                    >
                      {age === '60+' ? '60대+' : age.replace('s', '대')}
                    </button>
                  ))}
                </div>
              </div>

              {/* 수면 습관 */}
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-3 flex items-center gap-2">
                  <i className="ri-zzz-line"></i> 수면 중 뒤척임
                </h3>
                <div className="flex gap-3">
                  {(['low', 'medium', 'high'] as const).map((level) => (
                    <button
                      key={level}
                      onClick={() => setUserProfile({...userProfile, tossing: level})}
                      className={`flex-1 py-3 rounded-lg text-sm font-medium transition-all ${
                        userProfile.tossing === level 
                          ? 'bg-moa-main text-white' 
                          : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                      }`}
                    >
                      {level === 'low' ? '적음' : level === 'medium' ? '보통' : '많음'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 구강호흡 */}
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-3 flex items-center gap-2">
                  <i className="ri-lungs-line"></i> 수면 중 구강호흡
                </h3>
                <div className="flex gap-3">
                  <button
                    onClick={() => setUserProfile({...userProfile, mouthBreathing: true})}
                    className={`flex-1 py-3 rounded-lg font-medium transition-all ${
                      userProfile.mouthBreathing 
                        ? 'bg-moa-main text-white' 
                        : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                    }`}
                  >
                    예
                  </button>
                  <button
                    onClick={() => setUserProfile({...userProfile, mouthBreathing: false})}
                    className={`flex-1 py-3 rounded-lg font-medium transition-all ${
                      !userProfile.mouthBreathing 
                        ? 'bg-moa-main text-white' 
                        : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                    }`}
                  >
                    아니오
                  </button>
                </div>
              </div>

              {/* 압력 수치 */}
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-3 flex items-center gap-2">
                  <i className="ri-windy-line"></i> 양압기 압력 (cmH2O)
                </h3>
                <div className="flex gap-3">
                  {(['low', 'medium', 'high'] as const).map((level) => (
                    <button
                      key={level}
                      onClick={() => setUserProfile({...userProfile, pressure: level})}
                      className={`flex-1 py-3 rounded-lg text-sm font-medium transition-all ${
                        userProfile.pressure === level 
                          ? 'bg-moa-main text-white' 
                          : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary'
                      }`}
                    >
                      {level === 'low' ? '10 이하' : level === 'medium' ? '10-15' : '15 이상'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 선호 마스크 */}
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-2 flex items-center gap-2">
                  <i className="ri-mask-line"></i> 선호 마스크 타입 (복수선택)
                </h3>
                <p className="text-xs text-moa-text-tertiary mb-3">관심있는 타입을 모두 선택하세요</p>
                <div className="space-y-2">
                  {[
                    { type: 'nasal' as const, label: '나잘 (코만 덮음)', desc: '청장년층에 적합', icon: 'ri-nose-line' },
                    { type: 'pillow' as const, label: '필로우 (콧구멍만)', desc: '가볍고 편안함, 저압력용', icon: 'ri-contrast-drop-line' },
                    { type: 'full' as const, label: '풀페이스 (코+입)', desc: '구강호흡자, 중노년층', icon: 'ri-user-smile-line' }
                  ].map(({ type, label, desc, icon }) => (
                    <button
                      key={type}
                      onClick={() => {
                        const current = userProfile.preferredTypes;
                        const updated = current.includes(type)
                          ? current.filter(t => t !== type)
                          : [...current, type];
                        setUserProfile({...userProfile, preferredTypes: updated});
                      }}
                      className={`w-full p-3 rounded-lg text-left transition-all ${
                        userProfile.preferredTypes.includes(type)
                          ? 'bg-moa-main text-white border-2 border-moa-main-light' 
                          : 'bg-moa-bg-secondary text-moa-text-secondary hover:bg-moa-bg-tertiary border-2 border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <i className={icon}></i>
                          <div>
                            <div className="font-medium text-sm">{label}</div>
                            <div className="text-xs opacity-70 mt-0.5">{desc}</div>
                          </div>
                        </div>
                        {userProfile.preferredTypes.includes(type) && (
                          <i className="ri-check-line text-lg"></i>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 다음 버튼 */}
              <button
                onClick={() => {
                  setStep('IDLE');
                  setStatus('준비 완료');
                }}
                className="w-full py-4 rounded-xl bg-moa-main hover:opacity-90 font-bold text-white shadow-moa-color-1 transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                다음: 얼굴 측정 <i className="ri-arrow-right-line"></i>
              </button>
            </div>
              </div>
            </div>
          </div>
        )}

        {/* 1. IDLE 상태 */}
        {step === 'IDLE' && (
          <div className="absolute inset-0 flex flex-col">
            {/* 스크롤 가능한 컨텐츠 영역 */}
            <div className="flex-1 overflow-y-auto pt-24 pb-6 px-6 flex flex-col items-center justify-center">
            <h1 className="text-3xl font-bold mb-2 text-moa-main">
              SmartCare AI
            </h1>
            <p className="text-moa-text-secondary mb-8 text-center max-w-xs">
              정확한 양압기 마스크 추천을 위해<br />3D 안면 분석을 시작합니다.
            </p>
            <div className="space-y-4 w-full max-w-xs">
              <div className="glass-panel p-4">
                <h3 className="text-sm font-semibold text-moa-text-secondary mb-2 flex items-center gap-2">
                  <i className="ri-information-line"></i> 측정 가이드
                </h3>
                <ul className="text-xs text-moa-text-tertiary space-y-2 list-none pl-0">
                  <li className="flex items-start gap-2">
                    <i className="ri-lightbulb-line mt-0.5"></i>
                    <span>밝은 곳에서 촬영해주세요</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <i className="ri-glasses-line mt-0.5"></i>
                    <span>모자나 안경을 벗어주세요</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <i className="ri-scan-2-line mt-0.5"></i>
                    <span>정면과 측면 측정이 진행됩니다</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={startCamera}
                disabled={!user || !faceLandmarker || cameraStarting}
                className="w-full py-4 rounded-xl bg-moa-main hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-all active:scale-95 shadow-moa-color-1 flex items-center justify-center gap-2"
              >
                {cameraStarting ? (
                  <>
                    <i className="ri-loader-4-line animate-spin"></i>
                    카메라 연결 중...
                  </>
                ) : faceLandmarker ? (
                  <>
                    <i className="ri-camera-line"></i>
                    측정 시작하기
                  </>
                ) : (
                  <>
                    <i className="ri-loader-4-line animate-spin"></i>
                    시스템 로딩 중...
                  </>
                )}
              </button>
            </div>

            {latestMeasurement && (
              <div className="mt-8 text-xs text-center text-moa-text-tertiary flex items-center gap-2">
                <i className="ri-history-line"></i>
                최근 측정: {latestMeasurement.recommended_size} 사이즈 ({new Date(latestMeasurement.created_at!).toLocaleDateString()})
              </div>
            )}
            </div>
          </div>
        )}

        {/* 2. 가이드 오버레이 (공통) */}
        {step !== 'IDLE' && step !== 'SURVEY' && step !== 'COMPLETE' && (
          <div className="absolute inset-0 pointer-events-none pt-20">
            {/* 상단 메시지 바 */}
            <div className="absolute top-20 left-0 right-0 p-8 pt-8 glass-panel text-center z-10">
              <h2 className="text-xl font-bold text-moa-text drop-shadow-md">{status}</h2>
              <p className="text-sm text-moa-main mt-1 animate-pulse font-medium">{subStatus}</p>
            </div>

            {/* 측면 회전 가이드 - 좌우로 스무스한 화살표 애니메이션 */}
            {step === 'GUIDE_TURN_SIDE' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="flex items-center gap-8">
                  {/* 왼쪽 화살표 - 왼쪽으로 이동 */}
                  <i 
                    className="ri-arrow-left-s-line text-6xl text-moa-main" 
                    style={{ 
                      animation: 'slideLeft 2s ease-in-out infinite',
                      filter: 'drop-shadow(0 0 8px rgba(34, 211, 238, 0.6))'
                    }}
                  ></i>
                  
                  <div className="text-moa-main font-bold text-xl opacity-80">또는</div>
                  
                  {/* 오른쪽 화살표 - 오른쪽으로 이동 */}
                  <i 
                    className="ri-arrow-right-s-line text-6xl text-cyan-400" 
                    style={{ 
                      animation: 'slideRight 2s ease-in-out infinite',
                      filter: 'drop-shadow(0 0 8px rgba(34, 211, 238, 0.6))'
                    }}
                  ></i>
                </div>
              </div>
            )}

            <style jsx>{`
              @keyframes slideLeft {
                0%, 100% { transform: translateX(0); opacity: 1; }
                50% { transform: translateX(-20px); opacity: 0.7; }
              }
              @keyframes slideRight {
                0%, 100% { transform: translateX(0); opacity: 1; }
                50% { transform: translateX(20px); opacity: 0.7; }
              }
            `}</style>

            {/* 측정 중단 버튼 */}
            <div className="absolute top-4 right-4 z-20 pointer-events-auto">
              <button
                type="button"
                onClick={stopCamera}
                className="px-3 py-1.5 rounded-lg glass-panel hover:bg-red-600/80 text-white text-xs font-medium transition-colors flex items-center gap-1"
              >
                <i className="ri-close-line"></i>
                중단
              </button>
            </div>

            {/* 카운트다운 (작게 표시) */}
            {step === 'COUNTDOWN' && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center">
                <div className="relative">
                  <div className="absolute inset-0 opacity-20 blur-xl rounded-full"></div>
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
            <div className="h-2 bg-moa-bg-secondary rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500 transition-all duration-200"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* 5. 완료 결과 화면 */}
        {step === 'COMPLETE' && finalResult && recommendation && (
          <div className="absolute inset-0 flex flex-col z-30 animate-in fade-in slide-in-from-bottom-10 duration-500">
            {/* 스크롤 가능한 컨텐츠 영역 */}
            <div className="flex-1 overflow-y-auto pt-24 pb-32 px-6">
              <div className="flex flex-col items-center">
              <div className="w-20 h-20 bg-moa-main/20 rounded-full flex items-center justify-center mb-6 flex-shrink-0">
                <i className="ri-check-line text-4xl text-moa-main"></i>
              </div>

              <h2 className="text-2xl font-bold text-moa-text mb-1 flex-shrink-0">측정 완료</h2>
              <p className="text-moa-text-secondary text-sm mb-8 flex-shrink-0">AI 분석 결과가 준비되었습니다.</p>

              <div className="w-full max-w-md space-y-4 flex-shrink-0">
                {/* 추천 사이즈 */}
                <div className="glass-panel p-6">
                  <div className="flex justify-between items-center pb-4 border-b border-moa-bg-secondary">
                    <span className="text-moa-text-secondary flex items-center gap-2">
                      <i className="ri-ruler-line"></i>
                      추천 사이즈
                    </span>
                    <span className="text-3xl font-bold text-moa-main">
                      {recommendation.size}
                    </span>
                  </div>
                </div>

                {/* 추천 마스크 타입 */}
                <div className="glass-panel p-6">
                  <h3 className="text-lg font-bold text-moa-text mb-4 flex items-center gap-2">
                    <i className="ri-medal-line"></i>
                    추천 마스크 타입
                  </h3>
                  <div className="space-y-3">
                    {recommendation.types.map((typeRec, idx) => (
                      <div 
                        key={typeRec.type}
                        className={`p-4 rounded-xl border-2 ${
                          idx === 0 
                            ? 'bg-moa-main/20 border-moa-main' 
                            : 'bg-gray-700/50 border-gray-600'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            {idx === 0 && (
                              <span className="text-xs bg-moa-main text-white px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                                <i className="ri-trophy-line"></i>
                                1순위
                              </span>
                            )}
                            <span className="font-bold text-moa-text flex items-center gap-1">
                              <i className={
                                typeRec.type === 'nasal' ? 'ri-nose-line' : 
                                typeRec.type === 'pillow' ? 'ri-contrast-drop-line' : 
                                'ri-user-smile-line'
                              }></i>
                              {typeRec.type === 'nasal' ? '나잘' : typeRec.type === 'pillow' ? '필로우' : '풀페이스'}
                            </span>
                          </div>
                          <span className="text-sm font-semibold text-cyan-400">
                            {typeRec.score}점
                          </span>
                        </div>
                        
                        {typeRec.reasons.length > 0 && (
                          <div className="space-y-1 mb-2">
                            {typeRec.reasons.map((reason, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs text-green-400">
                                <i className="ri-check-line mt-0.5"></i>
                                <span>{reason}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        
                        {typeRec.warnings && typeRec.warnings.length > 0 && (
                          <div className="space-y-1">
                            {typeRec.warnings.map((warning, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs text-yellow-400">
                                <i className="ri-alert-line mt-0.5"></i>
                                <span>{warning}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 종합 의견 */}
                {recommendation.overallReasons.length > 0 && (
                  <div className="glass-panel p-6">
                    <h3 className="text-sm font-bold text-moa-text-secondary mb-3 flex items-center gap-2">
                      <i className="ri-lightbulb-line"></i>
                      종합 의견
                    </h3>
                    <div className="space-y-2">
                      {recommendation.overallReasons.map((reason, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm text-moa-text-secondary">
                          <i className="ri-arrow-right-s-line text-moa-main mt-0.5"></i>
                          <span>{reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 측정값 상세 */}
                <div className="glass-panel p-6">
                  <h3 className="text-sm font-bold text-moa-text-secondary mb-3 flex items-center gap-2">
                    <i className="ri-ruler-2-line"></i>
                    측정값 상세
                  </h3>
                  <div className="space-y-3 text-sm">
                    {/* 정면 측정값 */}
                    <div className="border-b border-moa-bg-secondary pb-3">
                      <h4 className="text-xs text-moa-text-tertiary mb-2 font-semibold">정면 측정</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">코 너비</div>
                          <div className="font-semibold text-moa-text">{finalResult.front.noseWidth}mm</div>
                        </div>
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">얼굴 길이</div>
                          <div className="font-semibold text-moa-text">{finalResult.front.faceLength}mm</div>
                        </div>
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">얼굴 폭</div>
                          <div className="font-semibold text-moa-text">{finalResult.front.faceWidth}mm</div>
                        </div>
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">미간 너비</div>
                          <div className="font-semibold text-moa-text">{finalResult.front.bridgeWidth}mm</div>
                        </div>
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">인중 길이</div>
                          <div className="font-semibold text-moa-main">{finalResult.front.philtrumLength}mm</div>
                        </div>
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">입 너비</div>
                          <div className="font-semibold text-moa-main">{finalResult.front.mouthWidth}mm</div>
                        </div>
                      </div>
                    </div>

                    {/* 측면 측정값 */}
                    <div>
                      <h4 className="text-xs text-moa-text-tertiary mb-2 font-semibold">측면 측정</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">코 높이</div>
                          <div className="font-semibold text-moa-main">{finalResult.profile.noseHeight}mm</div>
                        </div>
                        <div className="bg-moa-bg-tertiary p-3 rounded-lg">
                          <div className="text-moa-text-tertiary text-xs mb-1">턱 돌출</div>
                          <div className="font-semibold text-moa-main">{finalResult.profile.jawProjection}mm</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 mt-6 w-full max-w-md flex-shrink-0">
                <button
                  onClick={handleRetry}
                  className="flex-1 py-4 rounded-xl bg-gray-700 hover:bg-gray-600 font-bold text-white transition-colors flex items-center justify-center gap-2"
                >
                  <i className="ri-restart-line"></i>
                  재측정
                </button>
                <button
                  onClick={handleSave}
                  className="flex-[2] py-4 rounded-xl bg-moa-main hover:opacity-90 font-bold text-white shadow-moa-color-1 transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                  <i className="ri-save-line"></i>
                  결과 저장하기
                </button>
              </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}