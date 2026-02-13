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

  // 카운트다운
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
    
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setStep('GUIDE_CHECK');
      setStatus("정면을 봐주세요");
      startDetection();
    }
  }

  // 감지 루프
  function startDetection() {
    if (!videoRef.current || !canvasRef.current || !faceLandmarker) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    function loop() {
      if (!ctx || video.readyState < 2) {
        loopRef.current = requestAnimationFrame(loop);
        return;
      }
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const results = faceLandmarker!.detectForVideo(video, performance.now());
      
      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];
        drawLandmarks(ctx, landmarks, canvas.width, canvas.height);
        
        const measurements = performMeasurement(results);
        const yaw = estimateYaw(landmarks);
        
        if (measurements) {
          setCurrentMeasurements(measurements);
          handleStep(measurements, yaw, landmarks);
        }
      } else {
        if (step === 'GUIDE_CHECK' || step === 'GUIDE_TURN_SIDE') {
          setSubStatus("얼굴을 찾을 수 없습니다");
          stableCountRef.current = 0;
        }
      }
      
      if (step !== 'COMPLETE' && step !== 'IDLE') {
        loopRef.current = requestAnimationFrame(loop);
      }
    }
    
    loop();
  }

  // 단계별 처리
  function handleStep(m: FaceMeasurements, yaw: number, landmarks: any[]) {
    if (step === 'GUIDE_CHECK') {
      if (Math.abs(yaw) < 10) {
        if (!isFaceSizeValidForMeasurement(m)) {
          stableCountRef.current = 0;
          setSubStatus("얼굴을 가까이 해주세요");
          return;
        }
        stableCountRef.current++;
        setSubStatus(`확인 중... ${Math.min(stableCountRef.current, 20)}/20`);
        
        if (stableCountRef.current > 20) {
          setStatus("측정 시작");
          setSubStatus("");
          setStep('COUNTDOWN');
        }
      } else {
        stableCountRef.current = 0;
        setSubStatus("정면을 봐주세요");
      }
    }
    
    if (step === 'SCANNING_FRONT') {
      frontDataRef.current.push(m);
      const len = frontDataRef.current.length;
      const pct = Math.round((len / 90) * 100);
      
      if (len % 10 === 0) {
        setProgress(pct);
        setStatus("정면 스캔 중");
        setSubStatus(`${pct}%`);
      }
      
      if (len >= 90) {
        const avg = frontDataRef.current.reduce((a, c) => a + c.scaleFactor, 0) / len;
        scaleFactorRef.current = avg;
        setStep('GUIDE_TURN_SIDE');
        setStatus("측면 측정");
        setSubStatus("고개를 옆으로 돌려주세요");
        stableCountRef.current = 0;
        setProgress(0);
      }
    }
    
    if (step === 'GUIDE_TURN_SIDE') {
      if (Math.abs(yaw) > 35) {
        stableCountRef.current++;
        if (stableCountRef.current > 10) {
          setStep('SCANNING_PROFILE');
          profileDataRef.current = [];
        }
      } else {
        stableCountRef.current = 0;
      }
    }
    
    if (step === 'SCANNING_PROFILE') {
      const profile = performProfileMeasurement(landmarks, scaleFactorRef.current);
      profileDataRef.current.push(profile);
      const len = profileDataRef.current.length;
      const pct = Math.round((len / 90) * 100);
      
      if (len % 10 === 0) {
        setProgress(pct);
        setStatus("측면 스캔 중");
        setSubStatus(`${pct}%`);
      }
      
      if (len >= 90) {
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
    setStatus("측정 완료");
    
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    }
  }

  function calculateAvgFront(data: FaceMeasurements[]): FaceMeasurements {
    const sum = data.reduce((a, c) => ({
      noseWidth: a.noseWidth + c.noseWidth,
      faceLength: a.faceLength + c.faceLength,
      chinAngle: a.chinAngle + c.chinAngle,
      ipdPixels: a.ipdPixels + c.ipdPixels,
      scaleFactor: a.scaleFactor + c.scaleFactor,
      confidence: 0
    }), { noseWidth: 0, faceLength: 0, chinAngle: 0, ipdPixels: 0, scaleFactor: 0, confidence: 0 });
    
    const n = data.length;
    return {
      noseWidth: Math.round(sum.noseWidth / n * 10) / 10,
      faceLength: Math.round(sum.faceLength / n * 10) / 10,
      chinAngle: Math.round(sum.chinAngle / n * 10) / 10,
      ipdPixels: sum.ipdPixels / n,
      scaleFactor: sum.scaleFactor / n,
      confidence: 0.95
    };
  }

  function calculateAvgProfile(data: ProfileMeasurements[]): ProfileMeasurements {
    const sum = data.reduce((a, c) => ({
      noseHeight: a.noseHeight + c.noseHeight,
      faceDepth: a.faceDepth + c.faceDepth
    }), { noseHeight: 0, faceDepth: 0 });
    
    const n = data.length;
    return {
      noseHeight: Math.round(sum.noseHeight / n * 10) / 10,
      faceDepth: Math.round(sum.faceDepth / n * 10) / 10
    };
  }

  // 저장
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
      alert("저장되었습니다!");
      window.parent.postMessage({ type: 'MEASUREMENT_COMPLETE', data: result.data }, '*');
      setLatestMeasurement(result.data!);
    }
  }

  // 재측정
  function retry() {
    setStep('IDLE');
    setFinalFront(null);
    setFinalProfile(null);
    frontDataRef.current = [];
    profileDataRef.current = [];
    stableCountRef.current = 0;
  }

  // 중단
  function stop() {
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    }
    setStep('IDLE');
    frontDataRef.current = [];
    profileDataRef.current = [];
    stableCountRef.current = 0;
    if (loopRef.current) cancelAnimationFrame(loopRef.current);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black text-white">
      <div className="relative w-full h-screen max-w-md mx-auto bg-gray-900">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover ${step === 'IDLE' ? 'opacity-0' : 'opacity-100'}`}
          style={{ transform: 'scaleX(-1)' }}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: 'scaleX(-1)' }}
        />

        {step === 'IDLE' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-gray-800 to-black">
            <h1 className="text-3xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              SmartCare AI
            </h1>
            <p className="text-gray-400 mb-8 text-center">
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
                onClick={startMeasurement}
                disabled={!user || !faceLandmarker}
                className="w-full py-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 font-bold transition-all"
              >
                {faceLandmarker ? "측정 시작하기" : "시스템 로딩 중..."}
              </button>
            </div>

            {latestMeasurement && (
              <div className="mt-8 text-xs text-center text-gray-500">
                최근 측정: {latestMeasurement.recommended_size} 사이즈
              </div>
            )}
          </div>
        )}

        {step !== 'IDLE' && step !== 'COMPLETE' && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-0 left-0 right-0 p-8 pt-12 bg-gradient-to-b from-black/80 to-transparent text-center">
              <h2 className="text-xl font-bold text-white">{status}</h2>
              <p className="text-sm text-cyan-300 mt-1">{subStatus}</p>
            </div>

            <svg className="absolute inset-0 w-full h-full opacity-40" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
              {(step === 'GUIDE_CHECK' || step === 'SCANNING_FRONT' || step === 'COUNTDOWN') && (
                <ellipse cx="50" cy="50" rx="38" ry="42" fill="none" stroke="white" strokeWidth="0.8" strokeDasharray="4 4" />
              )}
              {step === 'GUIDE_TURN_SIDE' && (
                <path d="M 50 20 Q 80 20 80 50" fill="none" stroke="cyan" strokeWidth="1" />
              )}
            </svg>

            <div className="absolute top-4 right-4 pointer-events-auto">
              <button onClick={stop} className="px-3 py-1.5 rounded-lg bg-black/50 hover:bg-red-600/80 text-white text-xs">
                중단
              </button>
            </div>

            {step === 'COUNTDOWN' && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                <div className="text-6xl font-light text-white/90">{countdown}</div>
              </div>
            )}
          </div>
        )}

        {currentMeasurements && step !== 'IDLE' && step !== 'COMPLETE' && (
          <div className="absolute top-20 left-4 bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg text-xs space-y-1 border border-cyan-500/30">
            <div>코 너비: <span className="font-bold text-cyan-400">{currentMeasurements.noseWidth}mm</span></div>
            <div>얼굴 길이: <span className="font-bold text-cyan-400">{currentMeasurements.faceLength}mm</span></div>
            <div>턱 각도: <span className="font-bold text-cyan-400">{currentMeasurements.chinAngle}°</span></div>
          </div>
        )}

        {(step === 'SCANNING_FRONT' || step === 'SCANNING_PROFILE') && (
          <div className="absolute bottom-10 left-10 right-10">
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {step === 'COMPLETE' && finalFront && finalProfile && (
          <div className="absolute inset-0 bg-gray-900 flex flex-col p-6">
            <div className="flex-1 flex flex-col items-center pt-10">
              <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mb-6">
                <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                </svg>
              </div>

              <h2 className="text-2xl font-bold text-white mb-1">측정 완료</h2>
              <p className="text-gray-400 text-sm mb-8">AI 분석 결과가 준비되었습니다.</p>

              <div className="w-full bg-gray-800 rounded-2xl p-6 border border-gray-700 space-y-4">
                <div className="flex justify-between items-center pb-4 border-b border-gray-700">
                  <span className="text-gray-400">추천 사이즈</span>
                  <span className="text-3xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                    {recommendMaskSize(finalFront)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">코 너비</div>
                    <div className="font-semibold">{finalFront.noseWidth}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">얼굴 길이</div>
                    <div className="font-semibold">{finalFront.faceLength}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">코 높이</div>
                    <div className="font-semibold text-cyan-300">{finalProfile.noseHeight}mm</div>
                  </div>
                  <div className="bg-black/20 p-3 rounded-lg">
                    <div className="text-gray-500 text-xs mb-1">턱 각도</div>
                    <div className="font-semibold">{finalFront.chinAngle}°</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={retry} className="flex-1 py-4 rounded-xl bg-gray-700 hover:bg-gray-600 font-bold text-white">
                재측정
              </button>
              <button onClick={handleSave} className="flex-[2] py-4 rounded-xl bg-blue-600 hover:bg-blue-500 font-bold text-white">
                결과 저장하기
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
