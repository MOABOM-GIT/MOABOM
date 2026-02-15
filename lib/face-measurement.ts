/**
 * 얼굴 측정 유틸리티
 * MediaPipe Face Landmarker를 사용한 실제 거리 측정
 */

import { FaceLandmarker, FaceLandmarkerResult, FilesetResolver } from '@mediapipe/tasks-vision';

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

  // 입
  MOUTH_LEFT: 61,
  MOUTH_RIGHT: 291,
  UPPER_LIP_TOP: 13,
  LOWER_LIP_BOTTOM: 14,

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

// 평균 IPD (눈동자 간 거리) - mm 단위 (성별 구분)
const AVERAGE_IPD_MM = {
  male: 64,
  female: 62,
  default: 63
};

/** MediaPipe 랜드마크는 0~1 정규화 좌표. 눈 간 거리가 이 값 이상이어야 정확한 mm 환산 가능 (너무 멀면 과대 측정) */
export const MIN_IPD_NORMALIZED = 0.10;
/** 얼굴 길이 상한(mm). 이보다 크면 거리/캠 각도 문제로 과대 측정된 것으로 간주 */
export const FACE_LENGTH_MAX_MM = 280;

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
 * IPD (눈동자 간 거리) 계산 - 정규화된 좌표를 픽셀로 변환
 */
export function calculateIPDPixels(landmarks: any[], width: number, height: number): number {
  const leftEye = landmarks[LANDMARKS.LEFT_EYE_INNER];
  const rightEye = landmarks[LANDMARKS.RIGHT_EYE_INNER];
  
  // 정규화된 좌표(0~1)를 실제 픽셀로 변환
  const leftPixel = { x: leftEye.x * width, y: leftEye.y * height };
  const rightPixel = { x: rightEye.x * width, y: rightEye.y * height };
  
  return calculateDistance(leftPixel, rightPixel);
}

/**
 * 사용자 프로필 (설문 데이터)
 */
export interface UserProfile {
  gender: 'male' | 'female';
  ageGroup: '20s' | '30s' | '40s' | '50s' | '60+';
  tossing: 'low' | 'medium' | 'high';
  mouthBreathing: boolean;
  pressure: 'low' | 'medium' | 'high'; // <10, 10-15, 15+
  preferredTypes: ('nasal' | 'pillow' | 'full')[];
}

/**
 * 픽셀을 mm로 변환하는 스케일 팩터 계산 (성별 고려)
 */
export function calculateScaleFactor(ipdPixels: number, gender: 'male' | 'female' | 'default' = 'default'): number {
  const avgIPD = AVERAGE_IPD_MM[gender];
  return avgIPD / ipdPixels;
}

/**
 * 코 너비 측정 (mm) - 정규화된 좌표를 픽셀로 변환
 */
export function measureNoseWidth(landmarks: any[], scaleFactor: number, width: number, height: number): number {
  const noseLeft = landmarks[LANDMARKS.NOSE_LEFT];
  const noseRight = landmarks[LANDMARKS.NOSE_RIGHT];
  
  const leftPixel = { x: noseLeft.x * width, y: noseLeft.y * height };
  const rightPixel = { x: noseRight.x * width, y: noseRight.y * height };
  
  const widthPixels = calculateDistance(leftPixel, rightPixel);
  return widthPixels * scaleFactor;
}

/**
 * 얼굴 길이 측정 (mm) - 정규화된 좌표를 픽셀로 변환
 */
export function measureFaceLength(landmarks: any[], scaleFactor: number, width: number, height: number): number {
  const faceTop = landmarks[LANDMARKS.FACE_TOP];
  const chin = landmarks[LANDMARKS.CHIN];
  
  const topPixel = { x: faceTop.x * width, y: faceTop.y * height };
  const chinPixel = { x: chin.x * width, y: chin.y * height };
  
  const lengthPixels = calculateDistance(topPixel, chinPixel);
  return lengthPixels * scaleFactor;
}

/**
 * 얼굴 폭 측정 (mm) - 귀~귀
 */
export function measureFaceWidth(landmarks: any[], scaleFactor: number, width: number, height: number): number {
  const faceLeft = landmarks[LANDMARKS.FACE_LEFT];
  const faceRight = landmarks[LANDMARKS.FACE_RIGHT];
  
  const leftPixel = { x: faceLeft.x * width, y: faceLeft.y * height };
  const rightPixel = { x: faceRight.x * width, y: faceRight.y * height };
  
  const widthPixels = calculateDistance(leftPixel, rightPixel);
  return widthPixels * scaleFactor;
}

/**
 * 인중 길이 측정 (mm) - 코 밑~윗입술
 */
export function measurePhiltrumLength(landmarks: any[], scaleFactor: number, width: number, height: number): number {
  const noseBottom = landmarks[LANDMARKS.NOSE_BOTTOM];
  const upperLip = landmarks[LANDMARKS.UPPER_LIP_TOP];
  
  const nosePixel = { x: noseBottom.x * width, y: noseBottom.y * height };
  const lipPixel = { x: upperLip.x * width, y: upperLip.y * height };
  
  const lengthPixels = calculateDistance(nosePixel, lipPixel);
  return lengthPixels * scaleFactor;
}

/**
 * 입 너비 측정 (mm) - 풀페이스 마스크용
 */
export function measureMouthWidth(landmarks: any[], scaleFactor: number, width: number, height: number): number {
  const mouthLeft = landmarks[LANDMARKS.MOUTH_LEFT];
  const mouthRight = landmarks[LANDMARKS.MOUTH_RIGHT];
  
  const leftPixel = { x: mouthLeft.x * width, y: mouthLeft.y * height };
  const rightPixel = { x: mouthRight.x * width, y: mouthRight.y * height };
  
  const widthPixels = calculateDistance(leftPixel, rightPixel);
  return widthPixels * scaleFactor;
}

/**
 * 미간 너비 측정 (mm) - 콧대 압박 평가용
 */
export function measureBridgeWidth(landmarks: any[], scaleFactor: number, width: number, height: number): number {
  const leftEye = landmarks[LANDMARKS.LEFT_EYE_INNER];
  const rightEye = landmarks[LANDMARKS.RIGHT_EYE_INNER];
  
  const leftPixel = { x: leftEye.x * width, y: leftEye.y * height };
  const rightPixel = { x: rightEye.x * width, y: rightEye.y * height };
  
  const widthPixels = calculateDistance(leftPixel, rightPixel);
  return widthPixels * scaleFactor;
}

/**
 * 턱 각도 계산 (도) - DEPRECATED: 마스크 선정에 불필요
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
  faceWidth: number;
  philtrumLength: number;
  mouthWidth: number;
  bridgeWidth: number;
  confidence: number;
}

export function performMeasurement(result: FaceLandmarkerResult, width: number, height: number, gender: 'male' | 'female' | 'default' = 'default'): FaceMeasurements | null {
  if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
    return null;
  }

  const landmarks = result.faceLandmarks[0];

  // 1. IPD 계산 (기준점) - 실제 픽셀 거리
  const ipdPixels = calculateIPDPixels(landmarks, width, height);

  // 2. 스케일 팩터 계산 (성별 고려)
  const scaleFactor = calculateScaleFactor(ipdPixels, gender);

  // 3. 각 부위 측정
  const noseWidth = measureNoseWidth(landmarks, scaleFactor, width, height);
  const faceLength = measureFaceLength(landmarks, scaleFactor, width, height);
  const faceWidth = measureFaceWidth(landmarks, scaleFactor, width, height);
  const philtrumLength = measurePhiltrumLength(landmarks, scaleFactor, width, height);
  const mouthWidth = measureMouthWidth(landmarks, scaleFactor, width, height);
  const bridgeWidth = measureBridgeWidth(landmarks, scaleFactor, width, height);

  return {
    ipdPixels,
    scaleFactor,
    noseWidth: Math.round(noseWidth * 10) / 10,
    faceLength: Math.round(faceLength * 10) / 10,
    faceWidth: Math.round(faceWidth * 10) / 10,
    philtrumLength: Math.round(philtrumLength * 10) / 10,
    mouthWidth: Math.round(mouthWidth * 10) / 10,
    bridgeWidth: Math.round(bridgeWidth * 10) / 10,
    confidence: 0.95,
  };
}

/** 프레임 내 얼굴이 충분히 클 때만 true (멀리 있으면 false → 과대 측정 방지) */
export function isFaceSizeValidForMeasurement(measurements: FaceMeasurements): boolean {
  return measurements.ipdPixels >= MIN_IPD_NORMALIZED;
}

/** 측정값이 상식 범위인지 (과대 측정 시 false) */
export function isFaceLengthInRange(faceLengthMm: number): boolean {
  return faceLengthMm > 0 && faceLengthMm <= FACE_LENGTH_MAX_MM;
}

/**
 * 3D 안면 회전(Yaw) 추정 (도)
 * - 양쪽 눈 바깥 끝과 코 끝의 상대적 위치를 사용하여 대략적인 회전각 추정
 * - 0도: 정면, 양수: 오른쪽 회전, 음수: 왼쪽 회전
 */
export function estimateYaw(landmarks: any[]): number {
  const noseTip = landmarks[LANDMARKS.NOSE_TIP];
  const leftEyeOuter = landmarks[LANDMARKS.LEFT_EYE_OUTER];
  const rightEyeOuter = landmarks[LANDMARKS.RIGHT_EYE_OUTER]; // MediaPipe 기준 오른쪽 눈(화면상 왼쪽)

  // 2D 투영 상에서 코와 양쪽 눈의 x 거리 비교
  const distToLeft = Math.abs(noseTip.x - leftEyeOuter.x);
  const distToRight = Math.abs(noseTip.x - rightEyeOuter.x);

  // 비율 계산 (정면이면 1.0에 가까움)
  const totalDist = distToLeft + distToRight;
  if (totalDist === 0) return 0;

  // 정규화된 차이 (-1 ~ 1)
  // 오른쪽으로 고개를 돌리면(화면상 코가 왼쪽으로 이동) distToRight가 작아짐 -> 값 증가
  // 왼쪽으로 고개를 돌리면(화면상 코가 오른쪽으로 이동) distToLeft가 작아짐 -> 값 감소
  // MediaPipe 좌표계: x는 왼쪽이 0, 오른쪽이 1 (화면 기준)
  // 하지만 사용자 기준 '왼쪽 회전'은 코가 화면 왼쪽으로 가는 것일 수도 있음 (거울 모드 여부에따라 다름)

  // 간단한 비율 차이를 각도로 매핑 (보정 계수 필요)
  const ratio = (distToLeft - distToRight) / totalDist;

  // 대략 -1.0 ~ 1.0 범위를 -90 ~ 90도로 매핑 (선형 근사)
  return ratio * 90;
}

/**
 * 측면(Profile) 측정 - 코 높이/턱 돌출
 */
export interface ProfileMeasurements {
  noseHeight: number;
  jawProjection: number;
}

export function performProfileMeasurement(landmarks: any[], scaleFactor: number, width: number, height: number): ProfileMeasurements {
  const noseTip = landmarks[LANDMARKS.NOSE_TIP];
  const noseBottom = landmarks[LANDMARKS.NOSE_BOTTOM];
  const chin = landmarks[LANDMARKS.CHIN];
  const noseBridge = landmarks[LANDMARKS.NOSE_BRIDGE];

  // 정규화된 좌표를 픽셀로 변환
  const tipPixel = { x: noseTip.x * width, y: noseTip.y * height };
  const bottomPixel = { x: noseBottom.x * width, y: noseBottom.y * height };
  const chinPixel = { x: chin.x * width, y: chin.y * height };
  const bridgePixel = { x: noseBridge.x * width, y: noseBridge.y * height };

  // 코 높이: 코 끝과 인중 사이 거리
  const noseProjectionMax = calculateDistance(tipPixel, bottomPixel) * scaleFactor;

  // 턱 돌출: 턱 끝과 미간의 수평 거리 (측면에서 x축 차이)
  const jawProjectionPixels = Math.abs(chinPixel.x - bridgePixel.x);
  const jawProjection = jawProjectionPixels * scaleFactor;

  return {
    noseHeight: Math.round(noseProjectionMax * 10) / 10,
    jawProjection: Math.round(jawProjection * 10) / 10
  };
}

/**
 * 마스크 추천 결과
 */
export interface MaskRecommendation {
  size: string;
  types: {
    type: 'nasal' | 'pillow' | 'full';
    score: number;
    reasons: string[];
    warnings?: string[];
  }[];
  overallReasons: string[];
}

/**
 * 마스크 사이즈 추천 - 개선된 알고리즘 (설문 데이터 통합)
 */
export function recommendMaskAdvanced(
  measurements: FaceMeasurements,
  profile: ProfileMeasurements,
  userProfile: UserProfile
): MaskRecommendation {
  const { noseWidth, faceLength, faceWidth, mouthWidth, philtrumLength, bridgeWidth } = measurements;
  const { noseHeight, jawProjection } = profile;

  // 1. 사이즈 결정 (기존 로직)
  let sizeScore = 0;

  if (noseWidth < 35) sizeScore += 1;
  else if (noseWidth < 40) sizeScore += 2;
  else sizeScore += 3;

  if (faceLength < 180) sizeScore += 1;
  else if (faceLength < 210) sizeScore += 2;
  else sizeScore += 3;

  if (faceWidth < 130) sizeScore += 1;
  else if (faceWidth < 150) sizeScore += 2;
  else sizeScore += 3;

  if (mouthWidth < 45) sizeScore += 1;
  else if (mouthWidth < 55) sizeScore += 2;
  else sizeScore += 3;

  const size = sizeScore <= 6 ? 'S' : sizeScore <= 10 ? 'M' : 'L';

  // 2. 마스크 타입별 점수 계산
  const typeScores: { [key: string]: { score: number; reasons: string[]; warnings: string[] } } = {
    nasal: { score: 50, reasons: [], warnings: [] },
    pillow: { score: 50, reasons: [], warnings: [] },
    full: { score: 50, reasons: [], warnings: [] }
  };

  // 3. 연령대별 추천
  const ageRecommendations: { [key: string]: { nasal: number; pillow: number; full: number } } = {
    '20s': { nasal: 15, pillow: 15, full: 0 },
    '30s': { nasal: 15, pillow: 10, full: 5 },
    '40s': { nasal: 10, pillow: 5, full: 10 },
    '50s': { nasal: 5, pillow: 0, full: 15 },
    '60+': { nasal: 0, pillow: 0, full: 20 }
  };

  Object.entries(ageRecommendations[userProfile.ageGroup]).forEach(([type, bonus]) => {
    typeScores[type].score += bonus;
    if (bonus > 10) {
      typeScores[type].reasons.push(`${userProfile.ageGroup} 연령대에 적합`);
    }
  });

  // 4. 구강호흡 여부
  if (userProfile.mouthBreathing) {
    typeScores.full.score += 30;
    typeScores.full.reasons.push('구강호흡자에게 필수');
    typeScores.nasal.warnings.push('구강호흡 시 비효율적');
    typeScores.pillow.warnings.push('구강호흡 시 비효율적');
  } else {
    typeScores.nasal.score += 10;
    typeScores.pillow.score += 10;
  }

  // 5. 압력 수치
  if (userProfile.pressure === 'high') {
    typeScores.pillow.score -= 30;
    typeScores.pillow.warnings.push('15cmH2O 이상 압력에는 부적합');
    typeScores.full.score += 10;
    typeScores.full.reasons.push('고압력에 안정적');
  } else if (userProfile.pressure === 'low') {
    typeScores.pillow.score += 15;
    typeScores.pillow.reasons.push('저압력에 최적화');
  }

  // 6. 뒤척임 정도
  if (userProfile.tossing === 'high') {
    typeScores.pillow.score += 15;
    typeScores.pillow.reasons.push('가볍고 움직임에 강함');
    typeScores.full.score -= 10;
    typeScores.full.warnings.push('무겁고 움직임 제한');
  } else if (userProfile.tossing === 'low') {
    typeScores.full.score += 5;
  }

  // 7. 얼굴 측정값 기반 추천
  // 코 높이
  if (noseHeight > 18) {
    typeScores.nasal.score += 10;
    typeScores.nasal.reasons.push('높은 코에 적합');
  } else if (noseHeight < 12) {
    typeScores.pillow.score += 10;
    typeScores.pillow.reasons.push('낮은 코에 편안함');
  }

  // 인중 길이
  if (philtrumLength < 15) {
    typeScores.nasal.warnings.push('짧은 인중으로 압박 가능');
    typeScores.pillow.score += 5;
  }

  // 입 너비 (풀페이스 밀착도)
  if (mouthWidth > 70) {
    typeScores.full.score += 10;
    typeScores.full.reasons.push('넓은 입에 안정적 밀착');
  }

  // 미간 너비 (콧대 압박)
  if (bridgeWidth < 30) {
    typeScores.nasal.warnings.push('좁은 미간으로 압박 가능');
    typeScores.pillow.score += 5;
  }

  // 턱 돌출
  if (jawProjection < 5) {
    typeScores.full.warnings.push('무턱으로 하단 누출 가능');
  }

  // 8. 사용자 선호도 반영
  userProfile.preferredTypes.forEach(type => {
    typeScores[type].score += 20;
    typeScores[type].reasons.push('사용자 선호');
  });

  // 9. 최종 정렬 및 결과 생성
  const sortedTypes = Object.entries(typeScores)
    .map(([type, data]) => ({
      type: type as 'nasal' | 'pillow' | 'full',
      score: Math.max(0, Math.min(100, data.score)), // 0-100 범위로 제한
      reasons: data.reasons,
      warnings: data.warnings
    }))
    .sort((a, b) => b.score - a.score);

  // 10. 전체 추천 이유
  const overallReasons: string[] = [];
  overallReasons.push(`얼굴 측정 결과: ${size} 사이즈`);
  
  if (userProfile.mouthBreathing) {
    overallReasons.push('구강호흡으로 풀페이스 권장');
  }
  
  if (userProfile.pressure === 'high') {
    overallReasons.push('고압력 사용으로 안정적인 마스크 필요');
  }
  
  if (userProfile.tossing === 'high') {
    overallReasons.push('뒤척임이 많아 가벼운 마스크 권장');
  }

  return {
    size,
    types: sortedTypes,
    overallReasons
  };
}

/**
 * 마스크 사이즈 추천 - 기본 버전 (하위 호환성)
 */
export function recommendMaskSize(measurements: FaceMeasurements): string {
  const { noseWidth, faceLength, faceWidth, mouthWidth } = measurements;

  // 복합 점수 계산 (여러 측정값 고려)
  let score = 0;

  // 코 너비 점수
  if (noseWidth < 35) score += 1;
  else if (noseWidth < 40) score += 2;
  else score += 3;

  // 얼굴 길이 점수
  if (faceLength < 180) score += 1;
  else if (faceLength < 210) score += 2;
  else score += 3;

  // 얼굴 폭 점수
  if (faceWidth < 130) score += 1;
  else if (faceWidth < 150) score += 2;
  else score += 3;

  // 입 너비 점수 (풀페이스 마스크용)
  if (mouthWidth < 45) score += 1;
  else if (mouthWidth < 55) score += 2;
  else score += 3;

  // 총점 기준 사이즈 결정
  if (score <= 6) return 'S';
  else if (score <= 10) return 'M';
  else return 'L';
}

/**
 * MediaPipe FaceLandmarker 초기화
 */
export async function initializeFaceLandmarker(): Promise<FaceLandmarker> {
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

  return landmarker;
}

/**
 * 자세 검증 유틸리티
 */
export class PoseValidator {
  static isFrontFacing(yaw: number, threshold: number = 10): boolean {
    return Math.abs(yaw) < threshold;
  }

  static isProfileFacing(yaw: number, threshold: number = 35): boolean {
    return Math.abs(yaw) > threshold;
  }
}

/**
 * 측정 데이터 버퍼 관리
 */
export class MeasurementBuffer<T extends FaceMeasurements | ProfileMeasurements> {
  private buffer: T[] = [];
  private maxSize: number;

  constructor(maxSize: number = 90) {
    this.maxSize = maxSize;
  }

  add(measurement: T): void {
    this.buffer.push(measurement);
  }

  getProgress(): number {
    return Math.round((this.buffer.length / this.maxSize) * 100);
  }

  isFull(): boolean {
    return this.buffer.length >= this.maxSize;
  }

  getAverage(): T | null {
    if (this.buffer.length === 0) return null;

    const first = this.buffer[0];
    
    // FaceMeasurements 타입 체크
    if ('noseWidth' in first) {
      const sum = this.buffer.reduce((acc, cur) => {
        const m = cur as FaceMeasurements;
        return {
          noseWidth: acc.noseWidth + m.noseWidth,
          faceLength: acc.faceLength + m.faceLength,
          faceWidth: acc.faceWidth + m.faceWidth,
          philtrumLength: acc.philtrumLength + m.philtrumLength,
          mouthWidth: acc.mouthWidth + m.mouthWidth,
          bridgeWidth: acc.bridgeWidth + m.bridgeWidth,
          ipdPixels: acc.ipdPixels + m.ipdPixels,
          scaleFactor: acc.scaleFactor + m.scaleFactor,
          confidence: acc.confidence
        };
      }, { 
        noseWidth: 0, 
        faceLength: 0, 
        faceWidth: 0,
        philtrumLength: 0,
        mouthWidth: 0,
        bridgeWidth: 0,
        ipdPixels: 0, 
        scaleFactor: 0, 
        confidence: 0 
      });

      const count = this.buffer.length;
      return {
        noseWidth: Math.round(sum.noseWidth / count * 10) / 10,
        faceLength: Math.round(sum.faceLength / count * 10) / 10,
        faceWidth: Math.round(sum.faceWidth / count * 10) / 10,
        philtrumLength: Math.round(sum.philtrumLength / count * 10) / 10,
        mouthWidth: Math.round(sum.mouthWidth / count * 10) / 10,
        bridgeWidth: Math.round(sum.bridgeWidth / count * 10) / 10,
        ipdPixels: sum.ipdPixels / count,
        scaleFactor: sum.scaleFactor / count,
        confidence: 0.95
      } as T;
    }
    
    // ProfileMeasurements 타입
    if ('noseHeight' in first) {
      const sum = this.buffer.reduce((acc, cur) => {
        const m = cur as ProfileMeasurements;
        return {
          noseHeight: acc.noseHeight + m.noseHeight,
          jawProjection: acc.jawProjection + m.jawProjection
        };
      }, { noseHeight: 0, jawProjection: 0 });

      const count = this.buffer.length;
      return {
        noseHeight: Math.round(sum.noseHeight / count * 10) / 10,
        jawProjection: Math.round(sum.jawProjection / count * 10) / 10
      } as T;
    }

    return null;
  }

  getAverageScaleFactor(): number {
    if (this.buffer.length === 0) return 0;
    
    const first = this.buffer[0];
    if ('scaleFactor' in first) {
      const sum = this.buffer.reduce((acc, cur) => {
        const m = cur as FaceMeasurements;
        return acc + m.scaleFactor;
      }, 0);
      return sum / this.buffer.length;
    }
    
    return 0;
  }

  clear(): void {
    this.buffer = [];
  }

  getLength(): number {
    return this.buffer.length;
  }
}

/**
 * 측정 세션 관리 클래스
 */
export class FaceMeasurementSession {
  private frontBuffer: MeasurementBuffer<FaceMeasurements>;
  private profileBuffer: MeasurementBuffer<ProfileMeasurements>;
  private fixedScaleFactor: number = 0;

  constructor(scanFrames: number = 90) {
    this.frontBuffer = new MeasurementBuffer<FaceMeasurements>(scanFrames);
    this.profileBuffer = new MeasurementBuffer<ProfileMeasurements>(scanFrames);
  }

  addFrontMeasurement(measurement: FaceMeasurements): void {
    this.frontBuffer.add(measurement);
  }

  addProfileMeasurement(measurement: ProfileMeasurements): void {
    this.profileBuffer.add(measurement);
  }

  getFrontProgress(): number {
    return this.frontBuffer.getProgress();
  }

  getProfileProgress(): number {
    return this.profileBuffer.getProgress();
  }

  isFrontComplete(): boolean {
    return this.frontBuffer.isFull();
  }

  isProfileComplete(): boolean {
    return this.profileBuffer.isFull();
  }

  finalizeFrontMeasurement(): void {
    this.fixedScaleFactor = this.frontBuffer.getAverageScaleFactor();
  }

  getFixedScaleFactor(): number {
    return this.fixedScaleFactor;
  }

  getFinalResults(): { front: FaceMeasurements; profile: ProfileMeasurements } | null {
    const front = this.frontBuffer.getAverage();
    const profile = this.profileBuffer.getAverage();

    if (!front || !profile) return null;

    return { front, profile };
  }

  reset(): void {
    this.frontBuffer.clear();
    this.profileBuffer.clear();
    this.fixedScaleFactor = 0;
  }
}

/**
 * 캔버스에 랜드마크 그리기 - 과학적인 메시 스타일
 */
export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: any[],
  width: number,
  height: number,
  faceDetected: boolean = true // 얼굴 감지 여부
) {
  // 1. 얼굴 가이드 오버레이
  const faceCenter = { x: width / 2, y: height / 2 };
  const short = Math.min(width, height);
  const guideW = short * 0.36;
  const guideH = short * 0.42;

  // 얼굴 감지 여부에 따라 스타일 변경
  if (faceDetected) {
    // 얼굴 감지됨 - 굵은 실선
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
  } else {
    // 얼굴 없음 - 얇은 점선
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 5]);
  }

  ctx.beginPath();
  ctx.ellipse(faceCenter.x, faceCenter.y, guideW, guideH, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);

  // 텍스트는 좌우 반전 없이 정상으로 표시
  ctx.save();
  ctx.scale(-1, 1); // 텍스트만 다시 반전시켜서 정상으로
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('얼굴을 가이드 안에 맞춰주세요', -faceCenter.x, faceCenter.y - guideH - 20);
  ctx.restore();

  // 얼굴이 감지되지 않았으면 여기서 종료
  if (!faceDetected) {
    return;
  }

  // 2. 모든 랜드마크를 작은 흰색 반투명 점으로 표시 (크기와 진하기 증가)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  landmarks.forEach((landmark) => {
    const x = landmark.x * width;
    const y = landmark.y * height;

    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
    ctx.fill();
  });

  // 3. 주요 측정 라인 그리기 (밝은 청록색)
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
  ctx.lineWidth = 2;

  // 눈동자 간 거리 (IPD) - 가장 중요
  const leftPupil = landmarks[LANDMARKS.LEFT_PUPIL];
  const rightPupil = landmarks[LANDMARKS.RIGHT_PUPIL];
  ctx.beginPath();
  ctx.moveTo(leftPupil.x * width, leftPupil.y * height);
  ctx.lineTo(rightPupil.x * width, rightPupil.y * height);
  ctx.stroke();

  // 4. 눈 윤곽 상세 (MediaPipe Studio 스타일)
  ctx.strokeStyle = 'rgba(100, 200, 255, 0.7)';
  ctx.lineWidth = 1.5;

  // 왼쪽 눈 - 상하좌우 연결
  const leftEyePoints = [
    LANDMARKS.LEFT_EYE_INNER,
    LANDMARKS.LEFT_EYE_TOP,
    LANDMARKS.LEFT_EYE_OUTER,
    LANDMARKS.LEFT_EYE_BOTTOM,
    LANDMARKS.LEFT_EYE_INNER
  ];

  ctx.beginPath();
  leftEyePoints.forEach((index, i) => {
    const point = landmarks[index];
    const x = point.x * width;
    const y = point.y * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 오른쪽 눈
  const rightEyePoints = [
    LANDMARKS.RIGHT_EYE_INNER,
    LANDMARKS.RIGHT_EYE_TOP,
    LANDMARKS.RIGHT_EYE_OUTER,
    LANDMARKS.RIGHT_EYE_BOTTOM,
    LANDMARKS.RIGHT_EYE_INNER
  ];

  ctx.beginPath();
  rightEyePoints.forEach((index, i) => {
    const point = landmarks[index];
    const x = point.x * width;
    const y = point.y * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 5. 코 측정 라인
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
  ctx.lineWidth = 2;

  const noseLeft = landmarks[LANDMARKS.NOSE_LEFT];
  const noseRight = landmarks[LANDMARKS.NOSE_RIGHT];
  ctx.beginPath();
  ctx.moveTo(noseLeft.x * width, noseLeft.y * height);
  ctx.lineTo(noseRight.x * width, noseRight.y * height);
  ctx.stroke();

  // 6. 얼굴 길이 (세로)
  const faceTop = landmarks[LANDMARKS.FACE_TOP];
  const chin = landmarks[LANDMARKS.CHIN];
  ctx.beginPath();
  ctx.moveTo(faceTop.x * width, faceTop.y * height);
  ctx.lineTo(chin.x * width, chin.y * height);
  ctx.stroke();

  // 7. 얼굴 너비 (귀 근처) - 양쪽 끝에 동그라미 추가
  const faceLeft = landmarks[LANDMARKS.FACE_LEFT];
  const faceRight = landmarks[LANDMARKS.FACE_RIGHT];
  ctx.beginPath();
  ctx.moveTo(faceLeft.x * width, faceLeft.y * height);
  ctx.lineTo(faceRight.x * width, faceRight.y * height);
  ctx.stroke();

  // 얼굴 너비 양쪽 끝 동그라미
  ctx.fillStyle = 'rgba(0, 255, 255, 1)';
  ctx.shadowColor = 'rgba(0, 255, 255, 0.8)';
  ctx.shadowBlur = 10;
  
  ctx.beginPath();
  ctx.arc(faceLeft.x * width, faceLeft.y * height, 5, 0, 2 * Math.PI);
  ctx.fill();
  
  ctx.beginPath();
  ctx.arc(faceRight.x * width, faceRight.y * height, 5, 0, 2 * Math.PI);
  ctx.fill();
  
  ctx.shadowBlur = 0;

  // 8. 주요 포인트 강조 (더 크고 밝게)
  ctx.fillStyle = 'rgba(0, 255, 255, 1)';
  const keyPoints = [
    LANDMARKS.LEFT_PUPIL,
    LANDMARKS.RIGHT_PUPIL,
    LANDMARKS.NOSE_LEFT,
    LANDMARKS.NOSE_RIGHT,
    LANDMARKS.NOSE_TIP,
    LANDMARKS.FACE_TOP,
    LANDMARKS.CHIN,
  ];

  keyPoints.forEach(index => {
    const point = landmarks[index];
    const x = point.x * width;
    const y = point.y * height;

    // 외곽 글로우 효과
    ctx.shadowColor = 'rgba(0, 255, 255, 0.8)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}
