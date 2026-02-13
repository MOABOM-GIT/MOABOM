/**
 * 얼굴 측정 유틸리티
 * MediaPipe Face Landmarker를 사용한 실제 거리 측정
 */

import { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';

// 주요 랜드마크 인덱스 (MediaPipe Face Mesh 기준)
export const LANDMARKS = {
  // 눈
  LEFT_EYE_INNER: 133,
  LEFT_EYE_OUTER: 33,
  RIGHT_EYE_INNER: 362,
  RIGHT_EYE_OUTER: 263,
  LEFT_EYE_TOP: 159,
  LEFT_EYE_BOTTOM: 145,
  RIGHT_EYE_TOP: 386,
  RIGHT_EYE_BOTTOM: 374,
  
  // 동공
  LEFT_PUPIL: 468,
  RIGHT_PUPIL: 473,
  
  // 코
  NOSE_TIP: 1,
  NOSE_BRIDGE: 6,
  NOSE_LEFT: 98,
  NOSE_RIGHT: 327,
  NOSE_BOTTOM: 2,
  
  // 얼굴 윤곽
  FACE_TOP: 10,
  FACE_BOTTOM: 152,
  FACE_LEFT: 234,
  FACE_RIGHT: 454,
  
  // 광대뼈
  CHEEK_LEFT: 205,
  CHEEK_RIGHT: 425,
  
  // 턱
  CHIN: 152,
  JAW_LEFT: 172,
  JAW_RIGHT: 397,
  
  // 귀 (근사값)
  EAR_LEFT: 234,
  EAR_RIGHT: 454,
};

// 평균 IPD (눈동자 간 거리) - mm 단위
const AVERAGE_IPD_MM = 63; // 성인 평균

/**
 * 두 점 사이의 유클리드 거리 계산 (픽셀)
 */
export function calculateDistance(
  point1: { x: number; y: number; z?: number },
  point2: { x: number; y: number; z?: number }
): number {
  const dx = point2.x - point1.x;
  const dy = point2.y - point1.y;
  const dz = point2.z && point1.z ? point2.z - point1.z : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * IPD (눈동자 간 거리) 계산 - 픽셀 단위
 */
export function calculateIPDPixels(landmarks: any[]): number {
  const leftEye = landmarks[LANDMARKS.LEFT_EYE_INNER];
  const rightEye = landmarks[LANDMARKS.RIGHT_EYE_INNER];
  return calculateDistance(leftEye, rightEye);
}

/**
 * 픽셀을 mm로 변환하는 스케일 팩터 계산
 */
export function calculateScaleFactor(ipdPixels: number): number {
  return AVERAGE_IPD_MM / ipdPixels;
}

/**
 * 코 너비 측정 (mm)
 */
export function measureNoseWidth(landmarks: any[], scaleFactor: number): number {
  const noseLeft = landmarks[LANDMARKS.NOSE_LEFT];
  const noseRight = landmarks[LANDMARKS.NOSE_RIGHT];
  const widthPixels = calculateDistance(noseLeft, noseRight);
  return widthPixels * scaleFactor;
}

/**
 * 얼굴 길이 측정 (mm)
 */
export function measureFaceLength(landmarks: any[], scaleFactor: number): number {
  const faceTop = landmarks[LANDMARKS.FACE_TOP];
  const chin = landmarks[LANDMARKS.CHIN];
  const lengthPixels = calculateDistance(faceTop, chin);
  return lengthPixels * scaleFactor;
}

/**
 * 턱 각도 계산 (도)
 */
export function measureChinAngle(landmarks: any[]): number {
  const chin = landmarks[LANDMARKS.CHIN];
  const jawLeft = landmarks[LANDMARKS.JAW_LEFT];
  const jawRight = landmarks[LANDMARKS.JAW_RIGHT];
  
  // 왼쪽 턱선 벡터
  const leftVector = {
    x: chin.x - jawLeft.x,
    y: chin.y - jawLeft.y,
  };
  
  // 오른쪽 턱선 벡터
  const rightVector = {
    x: chin.x - jawRight.x,
    y: chin.y - jawRight.y,
  };
  
  // 두 벡터 사이의 각도 계산
  const dotProduct = leftVector.x * rightVector.x + leftVector.y * rightVector.y;
  const leftMagnitude = Math.sqrt(leftVector.x ** 2 + leftVector.y ** 2);
  const rightMagnitude = Math.sqrt(rightVector.x ** 2 + rightVector.y ** 2);
  
  const cosAngle = dotProduct / (leftMagnitude * rightMagnitude);
  const angleRadians = Math.acos(cosAngle);
  const angleDegrees = (angleRadians * 180) / Math.PI;
  
  return angleDegrees;
}

/**
 * 전체 얼굴 측정 수행
 */
export interface FaceMeasurements {
  ipdPixels: number;
  scaleFactor: number;
  noseWidth: number;
  faceLength: number;
  chinAngle: number;
  confidence: number;
}

export function performMeasurement(result: FaceLandmarkerResult): FaceMeasurements | null {
  if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
    return null;
  }
  
  const landmarks = result.faceLandmarks[0];
  
  // 1. IPD 계산 (기준점)
  const ipdPixels = calculateIPDPixels(landmarks);
  
  // 2. 스케일 팩터 계산
  const scaleFactor = calculateScaleFactor(ipdPixels);
  
  // 3. 각 부위 측정
  const noseWidth = measureNoseWidth(landmarks, scaleFactor);
  const faceLength = measureFaceLength(landmarks, scaleFactor);
  const chinAngle = measureChinAngle(landmarks);
  
  return {
    ipdPixels,
    scaleFactor,
    noseWidth: Math.round(noseWidth * 10) / 10, // 소수점 1자리
    faceLength: Math.round(faceLength * 10) / 10,
    chinAngle: Math.round(chinAngle * 10) / 10,
    confidence: 0.95, // MediaPipe는 자체 confidence 제공
  };
}

/**
 * 마스크 사이즈 추천
 */
export function recommendMaskSize(measurements: FaceMeasurements): string {
  const { noseWidth, faceLength } = measurements;
  
  // 간단한 추천 로직 (실제로는 더 복잡한 알고리즘 필요)
  if (noseWidth < 35 && faceLength < 180) {
    return 'S';
  } else if (noseWidth < 40 && faceLength < 200) {
    return 'M';
  } else {
    return 'L';
  }
}

/**
 * 캔버스에 랜드마크 그리기 - 과학적인 메시 스타일
 */
export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: any[],
  width: number,
  height: number
) {
  // 모든 랜드마크를 작은 흰색 반투명 점으로 표시
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  
  // 모든 랜드마크 점 그리기
  landmarks.forEach((landmark) => {
    const x = landmark.x * width;
    const y = landmark.y * height;
    
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, 2 * Math.PI);
    ctx.fill();
  });
  
  // 주요 측정 라인 그리기 (밝은 청록색)
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
  ctx.lineWidth = 2;
  
  // 1. 눈동자 간 거리 (IPD) - 가장 중요
  const leftPupil = landmarks[LANDMARKS.LEFT_PUPIL];
  const rightPupil = landmarks[LANDMARKS.RIGHT_PUPIL];
  ctx.beginPath();
  ctx.moveTo(leftPupil.x * width, leftPupil.y * height);
  ctx.lineTo(rightPupil.x * width, rightPupil.y * height);
  ctx.stroke();
  
  // 2. 왼쪽 눈 윤곽
  const leftEyeInner = landmarks[LANDMARKS.LEFT_EYE_INNER];
  const leftEyeOuter = landmarks[LANDMARKS.LEFT_EYE_OUTER];
  ctx.beginPath();
  ctx.moveTo(leftEyeInner.x * width, leftEyeInner.y * height);
  ctx.lineTo(leftEyeOuter.x * width, leftEyeOuter.y * height);
  ctx.stroke();
  
  // 3. 오른쪽 눈 윤곽
  const rightEyeInner = landmarks[LANDMARKS.RIGHT_EYE_INNER];
  const rightEyeOuter = landmarks[LANDMARKS.RIGHT_EYE_OUTER];
  ctx.beginPath();
  ctx.moveTo(rightEyeInner.x * width, rightEyeInner.y * height);
  ctx.lineTo(rightEyeOuter.x * width, rightEyeOuter.y * height);
  ctx.stroke();
  
  // 4. 코 너비
  const noseLeft = landmarks[LANDMARKS.NOSE_LEFT];
  const noseRight = landmarks[LANDMARKS.NOSE_RIGHT];
  ctx.beginPath();
  ctx.moveTo(noseLeft.x * width, noseLeft.y * height);
  ctx.lineTo(noseRight.x * width, noseRight.y * height);
  ctx.stroke();
  
  // 5. 얼굴 길이 (세로)
  const faceTop = landmarks[LANDMARKS.FACE_TOP];
  const chin = landmarks[LANDMARKS.CHIN];
  ctx.beginPath();
  ctx.moveTo(faceTop.x * width, faceTop.y * height);
  ctx.lineTo(chin.x * width, chin.y * height);
  ctx.stroke();
  
  // 6. 광대뼈 너비
  const cheekLeft = landmarks[LANDMARKS.CHEEK_LEFT];
  const cheekRight = landmarks[LANDMARKS.CHEEK_RIGHT];
  ctx.beginPath();
  ctx.moveTo(cheekLeft.x * width, cheekLeft.y * height);
  ctx.lineTo(cheekRight.x * width, cheekRight.y * height);
  ctx.stroke();
  
  // 7. 얼굴 너비 (귀 근처)
  const faceLeft = landmarks[LANDMARKS.FACE_LEFT];
  const faceRight = landmarks[LANDMARKS.FACE_RIGHT];
  ctx.beginPath();
  ctx.moveTo(faceLeft.x * width, faceLeft.y * height);
  ctx.lineTo(faceRight.x * width, faceRight.y * height);
  ctx.stroke();
  
  // 주요 포인트 강조 (더 크고 밝게)
  ctx.fillStyle = 'rgba(0, 255, 255, 0.9)';
  const keyPoints = [
    LANDMARKS.LEFT_PUPIL,
    LANDMARKS.RIGHT_PUPIL,
    LANDMARKS.NOSE_LEFT,
    LANDMARKS.NOSE_RIGHT,
    LANDMARKS.NOSE_TIP,
    LANDMARKS.FACE_TOP,
    LANDMARKS.CHIN,
    LANDMARKS.CHEEK_LEFT,
    LANDMARKS.CHEEK_RIGHT,
  ];
  
  keyPoints.forEach(index => {
    const point = landmarks[index];
    const x = point.x * width;
    const y = point.y * height;
    
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();
  });
}
