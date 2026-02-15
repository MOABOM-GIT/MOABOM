/**
 * CPAP Mask Measurement App - Type Definitions
 */

import type { FaceMeasurements, ProfileMeasurements, MaskRecommendation, UserProfile } from "@/lib/face-measurement";

export type MeasurementStep =
  | 'SURVEY'          // 설문 조사
  | 'IDLE'            // 대기
  | 'INIT'            // 초기화
  | 'GUIDE_CHECK'     // 정면 가이드 맞추기
  | 'COUNTDOWN'       // 3, 2, 1
  | 'SCANNING_FRONT'  // 정면 스캔 중
  | 'GUIDE_TURN_SIDE' // 측면 돌리기 안내
  | 'SCANNING_PROFILE'// 측면 스캔 중
  | 'COMPLETE';       // 완료

export interface MeasurementResult {
  front: FaceMeasurements;
  profile: ProfileMeasurements;
}

export type { UserProfile, MaskRecommendation };
