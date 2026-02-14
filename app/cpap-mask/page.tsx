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
} from "@/lib/face-measurement";

type Step = 'IDLE' | 'GUIDE_CHECK' | 'COUNTDOWN' | 'SCANNING_FRONT' | 'GUIDE_TURN_SIDE' | 'SCANNING_PROFILE' | 'COMPLETE';

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [step, setStep] = useState<Step>('IDLE');
  // [교정] 루프 내부에서 최신 상태를 참조하기 위한 Ref
  const stepRef = useRef<Step>('IDLE');
  
  const [user, setUser] = useState<MoabomUser | null>(null);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [latestMeasurement, setLatestMeasurement] = useState<MeasureLog | null>(null);
  
  const [status, setStatus] = useState("준비 완료");
  const [subStatus, setSubStatus] = useState("");
  const [countdown, setCountdown] = useState(3);
  const [progress, setProgress] = useState(0);
  
  const [currentMeasurements, setCurrentMeasurements] = useState<FaceMeasurements | null>(null);
  const [finalFront, setFinalFront] = useState<FaceMeasurements | null>(null);
  const [finalProfile, setFinalProfile] = useState<ProfileMeasurements | null>(null);
  
  const frontDataRef = useRef<FaceMeasurements[]>([]);
  const profileDataRef = useRef<ProfileMeasurements[]>([]);
  const scaleFactorRef = useRef<number>(0);
  const stableCountRef = useRef(0);
  const loopRef = useRef<number | null>(null);

  // [교정] Step 상태와 Ref 동기화 (루프가 길을 잃지 않게 함)
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // MediaPipe 초기화
  useEffect(() => {
    async function init() {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      const lm = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numFaces: 1,
      });
      setFaceLandmarker(lm);
    }
    init();
  }, []);

  // 사용자 초기화
  useEffect(() => {
    async function loadUser() {
      const u = getMoabomUser();
      if (u) {
        setUser(u);
        await getOrCreateUserProfile(u.mb_id, u.mb_email, u.mb_nick);
        const latest = await getLatestMeasurement(u.mb_id);
        if (latest) setLatestMeasurement(latest);
      }
    }
    loadUser();
  }, []);

  // 카운트다운 로직
  useEffect(() => {
    if (step === 'COUNTDOWN') {
      let c = 3;
      setCountdown(c);
      const t = setInterval(() => {
        c--;
        setCountdown(c);
        if (c === 0) {
          clearInterval(t);
          setStep('SCANNING_FRONT');
          frontDataRef.current = [];
          setProgress(0);
        }
      }, 1000);
      return () => clearInterval(t);
    }
  }, [step]);

  // 카메라 시작
  async function startMeasurement() {
    if (!user || !faceLandmarker) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play();
          setStep('GUIDE_CHECK');
          setStatus("정면을 봐주세요");
          startDetection();
        };
      }
    } catch (err) {
      console.error("Camera error:", err);
      alert("카메라를 켤 수 없습니다.");
    }
  }

  // 감지 루프
  function startDetection() {
    if (!videoRef.current || !canvasRef.current || !faceLandmarker) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    function loop() {
      // [교정] 루프 중단 조건: COMPLETE거나 IDLE이면 종료
      if (stepRef.current === 'COMPLETE' || stepRef.current === 'IDLE') {
        if (loopRef.current) cancelAnimationFrame(loopRef.current);
        return;
      }

      if (!ctx || video.readyState < 2) {
        loopRef.current = requestAnimationFrame(loop);
        return;
      }
      
      // [교정] PC 눌림 방지: 비디오의 실제 표시 크기와 캔버스 픽셀을 강제 일치시킴
      if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
        canvas.width = video.clientWidth;
        canvas.height = video.clientHeight;
      }
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const results = faceLandmarker!.detectForVideo(video, performance.now());
      
      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];
        
        // 랜드마크 그리기
        drawLandmarks(ctx, landmarks, canvas.width, canvas.height);
        
        const measurements = performMeasurement(results);
        const yaw = estimateYaw(landmarks);
        
        if (measurements) {
          setCurrentMeasurements(measurements);
          // [교정] stepRef.current를 직접 전달하여 최신 상태 전달
          handleStep(measurements, yaw, landmarks);
        }
      } else {
        const curStep = stepRef.current;
        if (curStep === 'GUIDE_CHECK' || curStep === 'GUIDE_TURN_SIDE') {
          setSubStatus("얼굴을 찾을 수 없습니다");
          stableCountRef.current = 0;
        }
      }
      
      loopRef.current = requestAnimationFrame(loop);
    }
    
    loop();
  }

  // 단계별 처리
  function handleStep(m: FaceMeasurements, yaw: number, landmarks: any[]) {
    const curStep = stepRef.current; // [교정] 클로저 방지: 항상 최신 Step 참조

    if (curStep === 'GUIDE_CHECK') {
      if (Math.abs(yaw) < 12) { // 오차범위 살짝 완화
        if (!isFaceSizeValidForMeasurement(m)) {
          stableCountRef.current = 0;
          setSubStatus("얼굴을 가이드 선에 맞춰주세요");
          return;
        }
        stableCountRef.current++;
        setSubStatus(`준비 중... ${Math.min(stableCountRef.current, 20)}/20`);
        
        if (stableCountRef.current > 20) {
          setStatus("측정 시작");
          setSubStatus("");
          setStep('COUNTDOWN');
        }
      } else {
        stableCountRef.current = 0;
        setSubStatus("정면을 똑바로 봐주세요");
      }
    }
    
    if (curStep === 'SCANNING_FRONT') {
      frontDataRef.current.push(m);
      const len = frontDataRef.current.length;
      const pct = Math.round((len / 80) * 100); // 90프레임에서 80으로 살짝 단축
      
      if (len % 5 === 0) {
        setProgress(pct);
        setStatus("정면 스캔 중...");
        setSubStatus(`${pct}%`);
      }
      
      if (len >= 80) {
        const avgScale = frontDataRef.current.reduce((a, c) => a + c.scaleFactor, 0) / len;
        scaleFactorRef.current = avgScale;
        setStep('GUIDE_TURN_SIDE');
        setStatus("측면 측정 준비");
        setSubStatus("오른쪽으로 천천히 돌려주세요 (35도 이상)");
        stableCountRef.current = 0;
        setProgress(0);
      }
    }
    
    if (curStep === 'GUIDE_TURN_SIDE') {
      if (Math.abs(yaw) > 30) { // 35도에서 30도로 현실적인 조정
        stableCountRef.current++;
        setSubStatus("각도 인식 완료! 유지하세요...");
        if (stableCountRef.current > 8) {
          setStep('SCANNING_PROFILE');
          profileDataRef.current = [];
        }
      } else {
        stableCountRef.current = 0;
        setSubStatus("고개를 더 돌려주세요");
      }
    }
    
    if (curStep === 'SCANNING_PROFILE') {
      const profile = performProfileMeasurement(landmarks, scaleFactorRef.current);
      profileDataRef.current.push(profile);
      const len = profileDataRef.current.length;
      const pct = Math.round((len / 60) * 100); // 측면은 조금 더 빨리 스캔 (60프레임)
      
      if (len % 5 === 0) {
        setProgress(pct);
        setStatus("측면 데이터 수집 중");
        setSubStatus(`${pct}%`);
      }
      
      if (len >= 60) {
        finishScan();
      }
    }
  }

  // 스캔 완료
  function finishScan() {
    const avgFront = calculateAvgFront(frontDataRef.current);
    const avgProfile = calculateAvgProfile(profileDataRef.current);
    
    setFinalFront(avgFront);
    setFinalProfile(avgProfile);
    setStep('COMPLETE');
    setStatus("분석 완료");
    
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    }
    if (loopRef.current) cancelAnimationFrame(loopRef.current);
  }

  function calculateAvgFront(data: FaceMeasurements[]): FaceMeasurements {
    const n = data.length;
    const sum = data.reduce((a, c) => ({
      noseWidth: a.noseWidth + c.noseWidth,
      faceLength: a.faceLength + c.faceLength,
      chinAngle: a.chinAngle + c.chinAngle,
      ipdPixels: a.ipdPixels + c.ipdPixels,
      scaleFactor: a.scaleFactor + c.scaleFactor,
      confidence: 0
    }), { noseWidth: 0, faceLength: 0, chinAngle: 0, ipdPixels: 0, scaleFactor: 0, confidence: 0 });
    
    return {
      noseWidth: Number((sum.noseWidth / n).toFixed(1)),
      faceLength: Number((sum.faceLength / n).toFixed(1)),
      chinAngle: Number((sum.chinAngle / n).toFixed(1)),
      ipdPixels: sum.ipdPixels / n,
      scaleFactor: sum.scaleFactor / n,
      confidence: 0.95
    };
  }

  function calculateAvgProfile(data: ProfileMeasurements[]): ProfileMeasurements {
    const n = data.length;
    const sum = data.reduce((a, c) => ({
      noseHeight: a.noseHeight + c.noseHeight,
      faceDepth: a.faceDepth + c.faceDepth
    }), { noseHeight: 0, faceDepth: 0 });
    
    return {
      noseHeight: Number((sum.noseHeight / n).toFixed(1)),
      faceDepth: Number((sum.faceDepth / n).toFixed(1))
    };
  }

  // 저장 로직 (그누보드 연동 포함)
  async function handleSave() {
    if (!user || !finalFront) return;
    
    const size = recommendMaskSize(finalFront);
    const result = await saveMeasurement({
      user_id: user.mb_id,
      user_name: user.mb_nick,
      nose_width: finalFront.noseWidth,
      face_length: finalFront.faceLength,
      chin_angle: finalFront.chinAngle,
      recommended_size: size,
      measurement_data: {
        timestamp: new Date().toISOString(),
        profile: finalProfile,
        front_raw: finalFront
      }
    });
    
    if (result.success) {
      alert("분석 데이터가 성공적으로 저장되었습니다.");
      // [교정] 부모창(그누보드)으로 결과 전송
      window.parent.postMessage({ type: 'MEASUREMENT_COMPLETE', size: size }, '*');
      setLatestMeasurement(result.data!);
    }
  }

  function retry() {
    setStep('IDLE');
    setFinalFront(null);
    setFinalProfile(null);
    frontDataRef.current = [];
    profileDataRef.current = [];
    stableCountRef.current = 0;
    setProgress(0);
  }

  function stop() {
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    }
    if (loopRef.current) cancelAnimationFrame(loopRef.current);
    setStep('IDLE');
    setStatus("준비 완료");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white font-sans overflow-hidden">
      <div className="relative w-full h-screen max-w-md mx-auto bg-gray-900 shadow-2xl">
        {/* 비디오 레이어 */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${step === 'IDLE' ? 'opacity-0' : 'opacity-100'}`}
          style={{ transform: 'scaleX(-1)' }}
        />
        {/* 가이드 & 랜드마크 캔버스 */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none z-10"
          style={{ transform: 'scaleX(-1)' }}
        />

        {/* 초기 시작 화면 */}
        {step === 'IDLE' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-8 bg-gradient-to-b from-gray-900 via-gray-800 to-black">
            <div className="w-20 h-20 bg-blue-600 rounded-3xl rotate-12 flex items-center justify-center mb-6 shadow-lg shadow-blue-500/20">
               <span className="text-4xl">🤖</span>
            </div>
            <h1 className="text-3xl font-black mb-3 tracking-tight">MOABOM <span className="text-blue-500">AI</span></h1>
            <p className="text-gray-400 mb-10 text-center leading-relaxed">
              최첨단 3D 안면 분석 기술로<br />
              지성님께 딱 맞는 마스크를 찾아드릴게요.
            </p>
            
            <div className="w-full space-y-4">
              <div className="bg-white/5 p-5 rounded-2xl border border-white/10 backdrop-blur-md">
                <h3 className="text-sm font-bold text-blue-400 mb-3 flex items-center">
                  <span className="mr-2">💡</span> 측정 전 확인해 주세요
                </h3>
                <ul className="text-xs text-gray-400 space-y-2.5">
                  <li className="flex items-start"><span className="mr-2">1.</span> 얼굴이 밝게 보이도록 조명을 마주 봐주세요.</li>
                  <li className="flex items-start"><span className="mr-2">2.</span> 안경이나 마스크를 잠시 벗어주세요.</li>
                  <li className="flex items-start"><span className="mr-2">3.</span> 안내에 따라 고개를 천천히 돌려주세요.</li>
                </ul>
              </div>

              <button
                onClick={startMeasurement}
                disabled={!user || !faceLandmarker}
                className="w-full py-4.5 rounded-2xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 font-extrabold text-lg transition-all active:scale-95 shadow-xl shadow-blue-600/30"
              >
                {faceLandmarker ? "분석 시작하기" : "AI 엔진 로딩 중..."}
              </button>
            </div>
          </div>
        )}

        {/* 스캔 진행 중 UI */}
        {step !== 'IDLE' && step !== 'COMPLETE' && (
          <div className="absolute inset-0 z-30 pointer-events-none">
            <div className="absolute top-0 left-0 right-0 p-10 pt-16 bg-gradient-to-b from-black/90 via-black/40 to-transparent text-center">
              <h2 className="text-xl font-extrabold tracking-tight text-white drop-shadow-md">{status}</h2>
              <p className="text-sm text-blue-400 font-bold mt-2 animate-pulse">{subStatus}</p>
            </div>

            {/* 가이드 타원 SVG */}
            <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-[70%] h-[55%] border-2 border-dashed border-white/30 rounded-[100px] animate-soft-pulse"></div>
            </div>

            <div className="absolute top-6 right-6 pointer-events-auto">
              <button onClick={stop} className="w-10 h-10 rounded-full bg-black/40 hover:bg-red-500/80 flex items-center justify-center transition-colors">
                <span className="text-lg">✕</span>
              </button>
            </div>

            {step === 'COUNTDOWN' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
                <div className="text-9xl font-black text-white drop-shadow-2xl animate-ping">{countdown}</div>
              </div>
            )}
          </div>
        )}

        {/* 실시간 수치 데이터 뱃지 */}
        {currentMeasurements && step !== 'IDLE' && step !== 'COMPLETE' && (
          <div className="absolute bottom-28 left-6 right-6 z-40 flex justify-between gap-2">
            {[
              { label: '코 너비', value: `${currentMeasurements.noseWidth}mm` },
              { label: '얼굴 길이', value: `${currentMeasurements.faceLength}mm` },
              { label: '턱 각도', value: `${currentMeasurements.chinAngle}°` }
            ].map((item, i) => (
              <div key={i} className="flex-1 bg-black/60 backdrop-blur-md border border-white/10 p-2.5 rounded-xl text-center">
                <div className="text-[10px] text-gray-400 mb-0.5">{item.label}</div>
                <div className="text-sm font-bold text-blue-400">{item.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* 하단 프로그레스 바 */}
        {(step === 'SCANNING_FRONT' || step === 'SCANNING_PROFILE') && (
          <div className="absolute bottom-12 left-8 right-8 z-50">
            <div className="h-3 bg-gray-800 rounded-full p-0.5 border border-white/5 shadow-inner">
              <div 
                className="h-full bg-gradient-to-r from-blue-600 to-cyan-400 rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(37,99,235,0.5)]" 
                style={{ width: `${progress}%` }} 
              />
            </div>
          </div>
        )}

        {/* 최종 결과 화면 */}
        {step === 'COMPLETE' && finalFront && finalProfile && (
          <div className="absolute inset-0 z-50 bg-gray-900 flex flex-col p-7 overflow-y-auto">
            <div className="flex-1 flex flex-col items-center pt-8">
              <div className="relative mb-8">
                <div className="w-24 h-24 bg-green-500/20 rounded-full flex items-center justify-center animate-bounce-slow">
                  <svg className="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="absolute -bottom-2 -right-2 bg-blue-600 text-[10px] px-2 py-1 rounded-lg font-bold">SUCCESS</div>
              </div>

              <h2 className="text-3xl font-black text-white mb-1">분석 완료!</h2>
              <p className="text-gray-400 text-sm mb-10">지성님을 위한 최적의 사이즈입니다.</p>

              <div className="w-full bg-gray-800/50 rounded-[32px] p-8 border border-white/10 backdrop-blur-xl mb-6">
                <div className="flex flex-col items-center pb-6 mb-6 border-b border-white/5">
                  <span className="text-xs text-gray-500 font-bold tracking-widest uppercase mb-2">Recommended Size</span>
                  <span className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-blue-400 to-blue-700">
                    {recommendMaskSize(finalFront)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: '코 너비', val: `${finalFront.noseWidth}mm` },
                    { label: '얼굴 길이', val: `${finalFront.faceLength}mm` },
                    { label: '코 높이', val: `${finalProfile.noseHeight}mm`, highlight: true },
                    { label: '턱 각도', val: `${finalFront.chinAngle}°` }
                  ].map((d, i) => (
                    <div key={i} className="bg-white/5 p-4 rounded-2xl">
                      <div className="text-[10px] text-gray-500 mb-1 font-bold">{d.label}</div>
                      <div className={`text-base font-bold ${d.highlight ? 'text-blue-400' : 'text-gray-200'}`}>{d.val}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-4 mb-4">
              <button onClick={retry} className="flex-1 py-4.5 rounded-2xl bg-gray-800 hover:bg-gray-700 font-bold text-gray-300 transition-colors">
                다시 측정
              </button>
              <button onClick={handleSave} className="flex-[2] py-4.5 rounded-2xl bg-blue-600 hover:bg-blue-500 font-black text-white transition-transform active:scale-95">
                결과 전송하기
              </button>
            </div>
          </div>
        )}
      </div>
      
      <style jsx global>{`
        @keyframes bounce-slow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        .animate-bounce-slow { animation: bounce-slow 3s infinite ease-in-out; }
        @keyframes soft-pulse {
          0%, 100% { border-color: rgba(255,255,255,0.2); }
          50% { border-color: rgba(59,130,246,0.6); }
        }
        .animate-soft-pulse { animation: soft-pulse 2s infinite; }
      `}</style>
    </div>
  );
}