/**
 * ProgressTabs Component
 * 상단 프로그레스 탭 (설문 → 안면분석 → 결과)
 */

import type { MeasurementStep } from '../types';

interface ProgressTabsProps {
  currentStep: MeasurementStep;
}

export default function ProgressTabs({ currentStep }: ProgressTabsProps) {
  const getCurrentPhase = (): 1 | 2 | 3 => {
    if (currentStep === 'SURVEY') return 1;
    if (currentStep === 'COMPLETE') return 3;
    return 2;
  };

  const currentPhase = getCurrentPhase();

  return (
    <div className="absolute top-0 left-0 right-0 z-50 glass-panel border-b border-moa-bg-secondary">
      <div className="flex items-center justify-center px-4 py-3">
        {[
          { phase: 1, label: '설문', icon: 'ri-survey-line' },
          { phase: 2, label: '안면분석', icon: 'ri-scan-line' },
          { phase: 3, label: '결과', icon: 'ri-check-line' }
        ].map(({ phase, label, icon }, idx) => {
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
  );
}
