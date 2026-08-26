import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { BoxedList, SettingsRow } from './primitives';
import { VoiceBlendEngine, BlendMode, BlendConfig } from '@/services/tts/VoiceBlendEngine';

const engine = new VoiceBlendEngine();

const VoiceBlendPanel: React.FC = () => {
  const _ = useTranslation();
  const [presets, setPresets] = useState(engine.presets);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<BlendMode>('linear');
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [genderFilter, setGenderFilter] = useState<'all' | 'male' | 'female'>('all');

  const voices = engine.allVoices.filter(
    (v) => genderFilter === 'all' || v.gender === genderFilter,
  );

  const refresh = () => setPresets(engine.presets);

  const toggleVoice = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 4 ? [...prev, id] : prev,
    );
  };

  const handleSave = () => {
    setError('');
    const cfg: BlendConfig = {
      mode,
      voiceIds: selected,
      weights:
        mode === 'weighted' ? selected.map((id) => weights[id] ?? 1 / selected.length) : undefined,
      name: name.trim(),
    };
    if (engine.save(cfg)) {
      setName('');
      setSelected([]);
      setWeights({});
      refresh();
    } else {
      setError(engine.validate(cfg) ?? 'Save failed');
    }
  };

  return (
    <div className='voice-blend-panel'>
      <BoxedList>
        <div className='px-4 py-2 font-semibold'>{_('Voice Blender')}</div>

        {/* Gender filter */}
        <SettingsRow label={_('Filter')}>
          <select
            className='select select-bordered w-full max-w-xs'
            value={genderFilter}
            onChange={(e) => setGenderFilter(e.target.value as any)}
          >
            <option value='all'>{_('All Voices')}</option>
            <option value='female'>{_('Female')}</option>
            <option value='male'>{_('Male')}</option>
          </select>
        </SettingsRow>

        {/* Voice selector */}
        <SettingsRow label={_('Source Voices')}>
          <div className='flex flex-wrap gap-2 max-w-xs'>
            {voices.map((v) => (
              <button
                key={v.id}
                className={`badge ${selected.includes(v.id) ? 'badge-primary' : 'badge-ghost'} cursor-pointer`}
                onClick={() => toggleVoice(v.id)}
                title={`${v.name} (${v.lang})`}
              >
                {v.name}
              </button>
            ))}
          </div>
        </SettingsRow>

        {selected.length > 0 && (
          <>
            {/* Blend mode */}
            <SettingsRow label={_('Mode')}>
              <div className='flex gap-2'>
                {(['linear', 'weighted', 'slerp'] as BlendMode[]).map((m) => (
                  <button
                    key={m}
                    className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </SettingsRow>

            {/* Weights (weighted mode) */}
            {mode === 'weighted' &&
              selected.map((id) => (
                <SettingsRow key={id} label={id}>
                  <input
                    type='range'
                    min={0}
                    max={100}
                    value={Math.round((weights[id] ?? 1 / selected.length) * 100)}
                    onChange={(e) => setWeights({ ...weights, [id]: +e.target.value / 100 })}
                    className='range w-full max-w-xs'
                  />
                </SettingsRow>
              ))}
          </>
        )}

        {/* Name & Save */}
        <SettingsRow label={_('Preset Name')}>
          <input
            className='input input-bordered w-full max-w-xs'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={_('My Custom Voice')}
          />
        </SettingsRow>

        {error && <div className='text-error text-sm px-4'>{error}</div>}

        <SettingsRow label=''>
          <button className='btn btn-primary' onClick={handleSave} disabled={selected.length < 2}>
            {_('Save Blend')}
          </button>
        </SettingsRow>
      </BoxedList>

      {/* Saved presets */}
      {presets.length > 0 && (
        <BoxedList className='mt-4'>
          <div className='px-4 py-2 font-semibold'>{_('Saved Presets')}</div>
          {presets.map((p) => (
            <div
              key={p.name}
              className='flex items-center justify-between px-4 py-2 border-b last:border-0'
            >
              <div>
                <span className='font-medium'>{p.name}</span>
                <span className='text-xs ml-2 opacity-60'>
                  {p.mode} · {p.voiceIds.length} voices
                </span>
              </div>
              <button
                className='btn btn-ghost btn-xs text-error'
                onClick={() => {
                  engine.delete(p.name);
                  refresh();
                }}
              >
                {_('Delete')}
              </button>
            </div>
          ))}
        </BoxedList>
      )}
    </div>
  );
};

export default VoiceBlendPanel;
