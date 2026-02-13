import { createClient } from '@supabase/supabase-js'

// Supabase 클라이언트 생성
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: {
    schema: 'cpap_mask' // 커스텀 스키마 지정
  }
})

// 타입 정의
export interface UserProfile {
  id?: number
  user_id: string
  user_name: string
  user_email?: string
  created_at?: string
  updated_at?: string
}

export interface MeasureLog {
  id?: number
  user_id: string
  user_name: string
  nose_width?: number
  face_length?: number
  chin_angle?: number
  recommended_size?: string
  measurement_data?: any
  created_at?: string
}

// 사용자 프로필 가져오기 또는 생성
export async function getOrCreateUserProfile(userId: string, userName: string, userEmail?: string): Promise<UserProfile | null> {
  try {
    // 기존 프로필 확인
    const { data: existing, error: fetchError } = await supabase
      .from('users_profile')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (existing) {
      return existing
    }

    // 없으면 새로 생성
    const { data: newProfile, error: insertError } = await supabase
      .from('users_profile')
      .insert({
        user_id: userId,
        user_name: userName,
        user_email: userEmail,
      })
      .select()
      .single()

    if (insertError) {
      console.error('[Supabase] Error creating profile:', insertError)
      return null
    }

    return newProfile
  } catch (error) {
    console.error('[Supabase] Error in getOrCreateUserProfile:', error)
    return null
  }
}

// 측정 결과 저장
export async function saveMeasurement(data: Omit<MeasureLog, 'id' | 'created_at'>): Promise<{ success: boolean; data?: MeasureLog; error?: any }> {
  try {
    const { data: result, error } = await supabase
      .from('measure_log')
      .insert(data)
      .select()
      .single()

    if (error) {
      console.error('[Supabase] Error saving measurement:', error)
      return { success: false, error }
    }

    return { success: true, data: result }
  } catch (error) {
    console.error('[Supabase] Error in saveMeasurement:', error)
    return { success: false, error }
  }
}

// 사용자의 측정 기록 가져오기
export async function getUserMeasurements(userId: string): Promise<MeasureLog[]> {
  try {
    const { data, error } = await supabase
      .from('measure_log')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[Supabase] Error fetching measurements:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('[Supabase] Error in getUserMeasurements:', error)
    return []
  }
}

// 최근 측정 결과 가져오기
export async function getLatestMeasurement(userId: string): Promise<MeasureLog | null> {
  try {
    const { data, error } = await supabase
      .from('measure_log')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      console.error('[Supabase] Error fetching latest measurement:', error)
      return null
    }

    return data
  } catch (error) {
    console.error('[Supabase] Error in getLatestMeasurement:', error)
    return null
  }
}
