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
 * 측면(Profile) 측정 - 코 높이/깊이
 * - 사용자가 측면을 보고 있을 때 사용
 * - 코 끝과 얼굴 평면(귀쪽) 거리 측정
 */
export interface ProfileMeasurements {
  noseHeight: number; // 코 높이 (깊이)
  faceDepth: number;  // 얼굴 깊이 (귀~코) - 참고용
}

export function performProfileMeasurement(landmarks: any[], scaleFactor: number): ProfileMeasurements {
  const noseTip = landmarks[LANDMARKS.NOSE_TIP];
  const noseBridge = landmarks[LANDMARKS.NOSE_BRIDGE]; // 미간

  // 측면에서는 코 끝이 가장 튀어나와 있음 (z축 혹은 x축 상의 거리)
  // 90도 완전 측면이 아닐 수 있으므로 3D 좌표 거리 활용하거나 
  // 투영된 2D 거리로 근사 계산

  // 간단한 근사: 코 끝과 콧대(미간) 사이의 거리를 "코 길이/높이"의 척도로 사용
  // 정확한 깊이(Depth) 측정은 단일 카메라로 어려우나, 
  // 고개를 돌렸을 때 코 끝이 얼굴 윤곽선에서 얼마나 떨어져 있는지를 계산할 수 있음.

  // 코 끝과 인중/입술 상단과의 거리도 코 높이와 관련 있음
  const noseBottom = landmarks[LANDMARKS.NOSE_BOTTOM];

  // 측면 뷰에서 '코 높이' 추정 (Projction)
  // 코 끝(1)과 콧볼/인중 부근의 랜드마크 거리
  const noseProjectionMax = calculateDistance(noseTip, noseBottom) * scaleFactor;

  return {
    noseHeight: Math.round(noseProjectionMax * 10) / 10,
    faceDepth: 0 // 현재는 신뢰할 수 없는 값
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
  // 1. 얼굴 가이드 오버레이 (계란형 -위가 넓고 아래 좁음)
  const faceCenter = {
    x: width / 2,
    y: height / 2
  };
  const guideWidth = width * 0.32;
  const guideHeight = height * 0.48;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 5]);
  ctx.beginPath();
  ctx.ellipse(faceCenter.x, faceCenter.y, guideWidth, guideHeight, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);

  // 가이드 텍스트
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('얼굴을 가이드 안에 맞춰주세요', faceCenter.x, faceCenter.y - guideHeight - 20);

  // 2. 모든 랜드마크를 작은 흰색 반투명 점으로 표시
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  landmarks.forEach((landmark) => {
    const x = landmark.x * width;
    const y = landmark.y * height;

    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
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

  // 7. 광대뼈 너비
  const cheekLeft = landmarks[LANDMARKS.CHEEK_LEFT];
  const cheekRight = landmarks[LANDMARKS.CHEEK_RIGHT];
  ctx.beginPath();
  ctx.moveTo(cheekLeft.x * width, cheekLeft.y * height);
  ctx.lineTo(cheekRight.x * width, cheekRight.y * height);
  ctx.stroke();

  // 8. 얼굴 너비 (귀 근처)
  const faceLeft = landmarks[LANDMARKS.FACE_LEFT];
  const faceRight = landmarks[LANDMARKS.FACE_RIGHT];
  ctx.beginPath();
  ctx.moveTo(faceLeft.x * width, faceLeft.y * height);
  ctx.lineTo(faceRight.x * width, faceRight.y * height);
  ctx.stroke();

  // 9. 주요 포인트 강조 (더 크고 밝게)
  ctx.fillStyle = 'rgba(0, 255, 255, 1)';
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

    // 외곽 글로우 효과
    ctx.shadowColor = 'rgba(0, 255, 255, 0.8)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}
