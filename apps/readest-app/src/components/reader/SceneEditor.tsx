import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Mood, CURVES } from '@/services/scene/types';

interface EditableSegment {
  id: string;
  text: string;
  mood: Mood;
  intensity: number;
  curve: string;
  dramatic_pause: boolean;
}

export interface SceneEditorProps {
  chapterIndex: number;
  segments: EditableSegment[];
  onSave: (
    chapterIndex: number,
    overrides: Record<
      string,
      { mood?: Mood; intensity?: number; curve?: string; dramatic_pause?: boolean }
    >,
  ) => void;
  onClose: () => void;
}

const MOOD_OPTIONS: Mood[] = [
  'tense',
  'calm',
  'mysterious',
  'joyful',
  'sad',
  'action',
  'romantic',
  'neutral',
];
const CURVE_OPTIONS = [...CURVES];

const SceneEditor: React.FC<SceneEditorProps> = ({ chapterIndex, segments, onSave, onClose }) => {
  const _ = useTranslation();
  const [overrides, setOverrides] = useState<Record<string, any>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const handleOverride = (id: string, field: string, value: any) => {
    setOverrides((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  };

  const handleSaveAll = () => {
    onSave(chapterIndex, overrides);
    onClose();
  };

  return (
    <div className='scene-editor fixed inset-0 z-50 flex items-center justify-center bg-black/40'>
      <div className='bg-base-100 rounded-box shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-4'>
        <div className='flex items-center justify-between mb-4'>
          <h2 className='text-lg font-semibold'>
            {_('Chapter {n}').replace('{n}', String(chapterIndex))}
          </h2>
          <button className='btn btn-ghost btn-sm' onClick={onClose}>
            {_('Close')}
          </button>
        </div>

        {segments.map((seg) => {
          const ov = overrides[seg.id] ?? {};
          const mood = ov.mood ?? seg.mood;
          const intensity = ov.intensity ?? seg.intensity;
          const curve = ov.curve ?? seg.curve;
          const dp = ov.dramatic_pause ?? seg.dramatic_pause;
          const isExpanded = expanded === seg.id;

          return (
            <div key={seg.id} className='border rounded-md mb-2 overflow-hidden'>
              <div
                className='flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-base-200'
                onClick={() => setExpanded(isExpanded ? null : seg.id)}
              >
                <span className='font-mono text-xs opacity-60'>{seg.id}</span>
                <div className='flex gap-2 items-center'>
                  <span className={`badge badge-sm ${mood === 'neutral' ? '' : 'badge-primary'}`}>
                    {mood}
                  </span>
                  <span className='text-xs opacity-60'>{Math.round(intensity * 100)}%</span>
                  <span className='text-xs opacity-60'>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {isExpanded && (
                <div className='px-3 pb-3 space-y-2'>
                  <p className='text-xs opacity-50 line-clamp-2'>{seg.text}</p>

                  <div className='flex flex-wrap gap-2'>
                    <label className='text-xs'>{_('Mood')}</label>
                    <select
                      className='select select-bordered select-xs w-full max-w-xs'
                      value={mood}
                      onChange={(e) => handleOverride(seg.id, 'mood', e.target.value)}
                    >
                      {MOOD_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className='flex items-center gap-2'>
                    <label className='text-xs'>{_('Intensity')}</label>
                    <input
                      type='range'
                      min={0}
                      max={100}
                      value={Math.round(intensity * 100)}
                      onChange={(e) => handleOverride(seg.id, 'intensity', +e.target.value / 100)}
                      className='range range-xs flex-1'
                    />
                    <span className='text-xs w-8'>{Math.round(intensity * 100)}%</span>
                  </div>

                  <div className='flex gap-2'>
                    <label className='text-xs'>{_('Curve')}</label>
                    {CURVE_OPTIONS.map((c) => (
                      <button
                        key={c}
                        className={`btn btn-xs ${curve === c ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => handleOverride(seg.id, 'curve', c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>

                  <label className='flex items-center gap-2 text-xs'>
                    <input
                      type='checkbox'
                      className='checkbox checkbox-xs'
                      checked={dp}
                      onChange={(e) => handleOverride(seg.id, 'dramatic_pause', e.target.checked)}
                    />
                    {_('Dramatic Pause')}
                  </label>
                </div>
              )}
            </div>
          );
        })}

        <div className='flex justify-end gap-2 mt-4'>
          <button className='btn btn-ghost' onClick={onClose}>
            {_('Cancel')}
          </button>
          <button className='btn btn-primary' onClick={handleSaveAll}>
            {_('Save Overrides')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SceneEditor;
